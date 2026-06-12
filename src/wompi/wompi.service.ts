import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHash } from 'crypto';
import { TopupPaymentMethod } from '../topups/entities/wallet-topup.entity';

// NOTA LEGAL: este modelo retiene dinero de usuarios y lo desembolsa a terceros. Para
// operar con dinero real en producción, ECIExpress debe estar regulada bajo la normativa
// financiera colombiana (SFC). En sandbox no aplica.

/** Estructura mínima del evento que envía Wompi a nuestro webhook. */
export interface WompiWebhookEvent {
  event: string;
  data: {
    transaction: {
      id: string;
      status: 'APPROVED' | 'DECLINED' | 'ERROR' | 'VOIDED' | 'PENDING';
      reference: string;
      amount_in_cents: number;
      [key: string]: unknown;
    };
  };
  signature: {
    checksum: string;
    properties: string[];
  };
  timestamp: number;
  sent_at?: string;
}

export interface CreateTopupTransactionParams {
  topupId: string;
  amountInCents: number;
  customerEmail: string;
  paymentMethod: TopupPaymentMethod;
  // Datos específicos del método que recoge el front (p. ej. token de tarjeta de Wompi,
  // teléfono de Nequi, datos PSE). NUNCA datos crudos de tarjeta: solo tokens de Wompi.
  paymentData?: Record<string, unknown>;
}

@Injectable()
export class WompiService {
  private readonly logger = new Logger(WompiService.name);

  constructor(private readonly configService: ConfigService) {}

  private get baseUrl(): string {
    return this.configService.getOrThrow<string>('wompi.baseUrl');
  }

  private get publicKey(): string {
    return this.configService.getOrThrow<string>('wompi.publicKey');
  }

  private get privateKey(): string {
    return this.configService.getOrThrow<string>('wompi.privateKey');
  }

  private get eventsSecret(): string {
    return this.configService.getOrThrow<string>('wompi.eventsSecret');
  }

  /** GET /merchants/:publicKey → devuelve el acceptance_token vigente. */
  async getAcceptanceToken(): Promise<string> {
    const response = await axios.get<{
      data: { presigned_acceptance: { acceptance_token: string } };
    }>(`${this.baseUrl}/merchants/${this.publicKey}`);
    return response.data.data.presigned_acceptance.acceptance_token;
  }

  /**
   * POST /transactions. Crea la transacción de recarga en Wompi sandbox y devuelve la
   * respuesta cruda (incluye, según el método, urls/datos asíncronos que el front usa
   * para completar el pago).
   *
   * `reference` usa el id del topup para garantizar unicidad e idempotencia: el webhook
   * trae esa misma referencia.
   */
  async createTopupTransaction(
    params: CreateTopupTransactionParams,
  ): Promise<Record<string, unknown>> {
    const acceptanceToken = await this.getAcceptanceToken();

    const integritySecret = this.configService.get<string>('wompi.integritySecret');
    if (!integritySecret) {
      this.logger.error('WOMPI_INTEGRITY_SECRET no está configurado');
      throw new Error('Configuración de Wompi incompleta');
    }

    const stringToHash = `${params.topupId}${params.amountInCents}COP${integritySecret}`;
    const integrity = createHash('sha256').update(stringToHash).digest('hex');

    this.logger.debug(`integritySecret presente: ${!!integritySecret}`);
    this.logger.debug(`reference: ${params.topupId}`);
    this.logger.debug(`amountInCents: ${params.amountInCents}`);
    this.logger.debug(`stringToHash: ${stringToHash}`);
    this.logger.debug(`integrity calculada: ${integrity}`);

    const { payment_method, customer_data } = this.buildTransactionExtras(
      params.paymentMethod,
      params.paymentData,
    );

    const body = {
      acceptance_token: acceptanceToken,
      amount_in_cents: params.amountInCents,
      currency: this.configService.get<string>('wompi.currency') ?? 'COP',
      customer_email: params.customerEmail,
      reference: params.topupId,
      signature: integrity,
      ...(customer_data && { customer_data }),
      payment_method,
    };

    this.logger.debug(`payload completo: ${JSON.stringify(body)}`);

    try {
      const response = await axios.post<{ data: Record<string, any> }>(
        `${this.baseUrl}/transactions`,
        body,
        { headers: { Authorization: `Bearer ${this.privateKey}` } },
      );
      return response.data.data;
    } catch (error) {
      const detail = axios.isAxiosError(error)
        ? JSON.stringify(error.response?.data)
        : (error as Error).message;
      this.logger.error(`Error creando transacción en Wompi: ${detail}`);
      throw error;
    }
  }

  /** GET /transactions/:id → datos completos de la transacción. */
  async getTransaction(transactionId: string): Promise<Record<string, unknown>> {
    const response = await axios.get<{ data: Record<string, unknown> }>(
      `${this.baseUrl}/transactions/${transactionId}`,
      { headers: { Authorization: `Bearer ${this.privateKey}` } },
    );
    return response.data.data;
  }

  /** GET /transactions/:id → solo el status. */
  async getTransactionStatus(transactionId: string): Promise<string> {
    const tx = await this.getTransaction(transactionId);
    return tx.status as string;
  }

  /**
   * Hace polling sobre GET /transactions/:id hasta que aparezca la URL de redirección
   * en `payment_method.extra.async_payment_url` o `payment_method.extra.url`.
   * Aplica a BANCOLOMBIA_TRANSFER, DAVIPLATA y PSE, que generan la URL de forma asíncrona.
   * Devuelve null si la URL no aparece dentro del tiempo límite.
   */
  async pollForRedirectUrl(
    transactionId: string,
    maxAttempts = 10,
    delayMs = 1000,
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const tx = await this.getTransaction(transactionId);
      const extra = (tx?.payment_method as Record<string, unknown>)
        ?.extra as Record<string, unknown> | undefined;
      const url = (extra?.async_payment_url ?? extra?.url) as string | undefined;

      if (url) {
        this.logger.debug(`redirectUrl encontrada en intento ${attempt}: ${url}`);
        return url;
      }

      this.logger.debug(
        `Intento ${attempt}/${maxAttempts}: redirectUrl aún no disponible para tx ${transactionId}`,
      );

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    this.logger.warn(
      `redirectUrl no apareció en ${maxAttempts} intentos para tx ${transactionId}`,
    );
    return null;
  }

  /** GET /pse/financial_institutions → lista de bancos disponibles para PSE. */
  async getFinancialInstitutions(): Promise<Record<string, unknown>[]> {
    const response = await axios.get<{ data: Record<string, unknown>[] }>(
      `${this.baseUrl}/pse/financial_institutions`,
      { headers: { Authorization: `Bearer ${this.privateKey}` } },
    );
    return response.data.data;
  }

  /**
   * Valida la firma de un evento de Wompi.
   * Algoritmo: SHA256( valores_de_properties + timestamp + eventsSecret )
   * Los valores se sacan de `data` navegando la ruta "transaction.id" → data.transaction.id.
   * El hash resultante (hex lowercase) debe coincidir exactamente con `signature.checksum`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifyWebhookSignature(body: any): boolean {
    try {
      const eventsSecret = this.configService.get<string>('wompi.eventsSecret');
      const { signature, timestamp, data } = body;

      if (!signature?.checksum || !signature?.properties || !timestamp) {
        return false;
      }

      const concatenated = (signature.properties as string[])
        .map((prop) =>
          prop.split('.').reduce((obj: any, key: string) => obj?.[key], data),
        )
        .join('');

      const stringToHash = `${concatenated}${timestamp}${eventsSecret}`;
      const calculated = createHash('sha256').update(stringToHash).digest('hex');

      const isValid = calculated === signature.checksum;
      if (!isValid) {
        this.logger.warn(
          `Firma de webhook inválida. stringToHash: ${stringToHash} | calculado: ${calculated} | recibido: ${signature.checksum as string}`,
        );
      }
      return isValid;
    } catch {
      return false;
    }
  }

  /**
   * Construye `payment_method` y, cuando el método lo requiere, `customer_data`
   * (PSE lo exige al nivel raíz del payload de la transacción).
   * NUNCA se reciben datos crudos de tarjeta: solo tokens generados por Wompi.
   */
  private buildTransactionExtras(
    method: TopupPaymentMethod,
    paymentData: Record<string, unknown> = {},
  ): {
    payment_method: Record<string, unknown>;
    customer_data?: Record<string, unknown>;
  } {
    switch (method) {
      case TopupPaymentMethod.NEQUI:
        return {
          payment_method: {
            type: 'NEQUI',
            phone_number: paymentData.phone_number as string,
          },
        };

      case TopupPaymentMethod.DAVIPLATA:
        return {
          payment_method: {
            type: 'DAVIPLATA',
            phone_number: paymentData.phone_number as string,
            user_legal_id_type: paymentData.user_legal_id_type as string,
            user_legal_id: paymentData.user_legal_id as string,
          },
        };

      case TopupPaymentMethod.PSE:
        return {
          payment_method: {
            type: 'PSE',
            user_type: paymentData.user_type,
            user_legal_id_type: paymentData.user_legal_id_type,
            user_legal_id: paymentData.user_legal_id,
            financial_institution_code: paymentData.financial_institution_code,
            payment_description: 'Recarga billetera ECIExpress',
          },
          // PSE requiere customer_data al nivel raíz de la transacción, no dentro de payment_method.
          customer_data: {
            phone_number: paymentData.customer_phone as string,
            full_name: paymentData.customer_full_name as string,
          },
        };

      case TopupPaymentMethod.CARD:
        return {
          payment_method: {
            type: 'CARD',
            token: paymentData.token as string,
            installments: (paymentData.installments as number) ?? 1,
          },
        };

      case TopupPaymentMethod.BANCOLOMBIA_TRANSFER:
        return {
          payment_method: {
            type: 'BANCOLOMBIA_TRANSFER',
            user_type: 'PERSON',
            payment_description: 'Recarga billetera ECIExpress',
            // sandbox_status simula el resultado en sandbox; no enviar en producción.
            ...(process.env.NODE_ENV !== 'production' && { sandbox_status: 'APPROVED' }),
          },
        };

      case TopupPaymentMethod.BANCOLOMBIA_QR:
        // La respuesta incluye extra.qr_image (base64 SVG). El frontend lo renderiza como:
        // <img src={`data:image/svg+xml;base64,${wompi.extra.qr_image}`} />
        return {
          payment_method: {
            type: 'BANCOLOMBIA_QR',
            payment_description: 'Recarga billetera ECIExpress',
            ...(process.env.NODE_ENV !== 'production' && { sandbox_status: 'APPROVED' }),
          },
        };

      default:
        throw new BadRequestException('Método de pago no soportado actualmente.');
    }
  }
}
