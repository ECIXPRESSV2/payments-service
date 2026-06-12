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

  private get integritySecret(): string {
    return this.configService.getOrThrow<string>('wompi.integritySecret');
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

    const integrity = createHash('sha256')
      .update(
        `${params.topupId}${params.amountInCents}COP${this.integritySecret}`,
      )
      .digest('hex');

    const body = {
      acceptance_token: acceptanceToken,
      amount_in_cents: params.amountInCents,
      currency: this.configService.get<string>('wompi.currency') ?? 'COP',
      customer_email: params.customerEmail,
      reference: params.topupId,
      signature: { integrity },
      payment_method: this.buildPaymentMethod(
        params.paymentMethod,
        params.paymentData,
      ),
    };

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

  /** GET /transactions/:id → estado actual de la transacción. */
  async getTransactionStatus(transactionId: string): Promise<string> {
    const response = await axios.get<{ data: { status: string } }>(
      `${this.baseUrl}/transactions/${transactionId}`,
      {
        headers: { Authorization: `Bearer ${this.privateKey}` },
      },
    );
    return response.data.data.status;
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
   * Valida la firma de un evento de Wompi según la documentación oficial:
   * se concatenan, en orden, los valores de las propiedades indicadas en
   * `signature.properties` (rutas tipo "transaction.id"), seguidos del `timestamp`
   * del evento y del secreto de eventos. El SHA256 (hex en mayúsculas) de esa cadena
   * debe coincidir con `signature.checksum`.
   */
  verifyWebhookSignature(event: WompiWebhookEvent): boolean {
    if (!event?.signature?.properties || !event.signature.checksum) {
      return false;
    }

    const concatenatedValues = event.signature.properties
      .map((path) => this.resolveProperty(event.data, path))
      .join('');

    const stringToHash = `${concatenatedValues}${event.timestamp}${this.eventsSecret}`;
    const computedChecksum = createHash('sha256')
      .update(stringToHash)
      .digest('hex')
      .toUpperCase();

    const isValid = computedChecksum === event.signature.checksum.toUpperCase();
    if (!isValid) {
      this.logger.warn('Firma de webhook de Wompi inválida.');
    }
    return isValid;
  }

  /**
   * Resuelve una ruta tipo "transaction.amount_in_cents" dentro de `event.data`.
   * Las propiedades del checksum vienen relativas al objeto `data`.
   */
  private resolveProperty(data: unknown, path: string): string {
    const value = path
      .split('.')
      .reduce<unknown>(
        (acc, key) => (acc as Record<string, unknown>)?.[key],
        data,
      );
    switch (typeof value) {
      case 'string':
        return value;
      case 'number':
      case 'boolean':
      case 'bigint':
        return value.toString();
      case 'undefined':
        return '';
      default:
        return value === null ? '' : JSON.stringify(value);
    }
  }

  /**
   * Construye el objeto `payment_method` según el método. Los datos sensibles
   * (token de tarjeta, teléfono, datos PSE) los recoge y tokeniza el front y llegan
   * en `paymentData`. NUNCA se reciben datos crudos de tarjeta: solo tokens de Wompi.
   */
  private buildPaymentMethod(
    method: TopupPaymentMethod,
    paymentData: Record<string, unknown> = {},
  ): Record<string, unknown> {
    switch (method) {
      case TopupPaymentMethod.NEQUI:
        return {
          type: 'NEQUI',
          phone_number: paymentData.phone_number as string,
        };

      case TopupPaymentMethod.DAVIPLATA:
        return {
          type: 'DAVIPLATA',
          phone_number: paymentData.phone_number as string,
        };

      case TopupPaymentMethod.PSE:
        return {
          type: 'PSE',
          user_type: paymentData.user_type,
          user_legal_id_type: paymentData.user_legal_id_type,
          user_legal_id: paymentData.user_legal_id,
          financial_institution_code: paymentData.financial_institution_code,
          payment_description: 'Recarga billetera ECIExpress',
        };

      case TopupPaymentMethod.CARD:
        return {
          type: 'CARD',
          token: paymentData.token as string,
          installments: (paymentData.installments as number) ?? 1,
        };

      default:
        throw new BadRequestException('Método de pago no soportado actualmente.');
    }
  }
}
