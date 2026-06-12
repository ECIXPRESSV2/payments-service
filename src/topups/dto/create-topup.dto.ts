import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TopupPaymentMethod } from '../entities/wallet-topup.entity';

export class PaymentDataDto {
  /** NEQUI / DAVIPLATA: número de celular registrado (10 dígitos). */
  @IsOptional()
  @IsString()
  @Matches(/^\d{10}$/, {
    message: 'phone_number debe tener exactamente 10 dígitos.',
  })
  phone_number?: string;

  /** PSE: 0 = persona natural, 1 = persona jurídica. */
  @IsOptional()
  @IsInt()
  user_type?: number;

  /** PSE: tipo de documento (CC, NIT, CE, etc.). */
  @IsOptional()
  @IsString()
  user_legal_id_type?: string;

  /** PSE: número de documento del titular. */
  @IsOptional()
  @IsString()
  user_legal_id?: string;

  /** PSE: código del banco (obtenible en GET /wallet/topups/pse-institutions). */
  @IsOptional()
  @IsString()
  financial_institution_code?: string;

  /** CARD: token generado por el widget de Wompi en el frontend. */
  @IsOptional()
  @IsString()
  token?: string;

  /** CARD: número de cuotas (por defecto 1). */
  @IsOptional()
  @IsInt()
  @Min(1)
  installments?: number;
}

export class CreateTopupDto {
  @ApiProperty({
    example: 50000,
    description: 'Monto a recargar en centavos COP (mínimo 1000 = $10 COP).',
  })
  @IsInt()
  @Min(1000, { message: 'El monto mínimo de recarga es 1000 centavos (10 COP).' })
  amount: number;

  @ApiProperty({
    enum: TopupPaymentMethod,
    example: TopupPaymentMethod.NEQUI,
    description: 'Método de pago.',
  })
  @IsEnum(TopupPaymentMethod)
  paymentMethod: TopupPaymentMethod;

  @ApiProperty({
    description: 'Datos del método de pago según el tipo seleccionado.',
    examples: {
      NEQUI: {
        summary: 'Nequi',
        value: { phone_number: '3001234567' },
      },
      DAVIPLATA: {
        summary: 'Daviplata',
        value: { phone_number: '3001234567' },
      },
      PSE: {
        summary: 'PSE',
        value: {
          user_type: 0,
          user_legal_id_type: 'CC',
          user_legal_id: '123456789',
          financial_institution_code: '1007',
        },
      },
      CARD: {
        summary: 'Tarjeta (token de Wompi)',
        value: { token: 'tok_test_...', installments: 1 },
      },
    },
  })
  @IsNotEmpty({ message: 'paymentData es requerido para este método de pago.' })
  @IsObject()
  @ValidateNested()
  @Type(() => PaymentDataDto)
  paymentData: PaymentDataDto;
}
