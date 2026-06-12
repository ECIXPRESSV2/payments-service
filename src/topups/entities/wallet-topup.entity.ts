import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigIntTransformer } from '../../common/transformers/bigint.transformer';

/**
 * Métodos de pago soportados para recargar la billetera via Wompi.
 *
 * Bre-B está disponible en Wompi solo como QR interoperable desde el widget,
 * no como payment_method en la API de transacciones. No implementar hasta que
 * Wompi lo exponga en su API pública.
 */
export enum TopupPaymentMethod {
  NEQUI = 'NEQUI',
  DAVIPLATA = 'DAVIPLATA',
  PSE = 'PSE',
  CARD = 'CARD',
}

export enum TopupStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  FAILED = 'FAILED',
}

/**
 * Recarga de la billetera. Se crea en estado PENDING junto con la transacción en Wompi.
 * El saldo SOLO se acredita cuando el webhook de Wompi confirma el estado APPROVED.
 */
@Entity('wallet_topups')
export class WalletTopup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId: string;

  @Column({ type: 'bigint', transformer: bigIntTransformer })
  amount: number;

  @Column({ name: 'payment_method', type: 'enum', enum: TopupPaymentMethod })
  paymentMethod: TopupPaymentMethod;

  @Column({ type: 'enum', enum: TopupStatus, default: TopupStatus.PENDING })
  status: TopupStatus;

  @Index('idx_wallet_topups_wompi_tx_id', {
    unique: true,
    where: '"wompi_transaction_id" IS NOT NULL',
  })
  @Column({ name: 'wompi_transaction_id', type: 'varchar', nullable: true })
  wompiTransactionId?: string | null;

  @Column({ name: 'wompi_response', type: 'jsonb', nullable: true })
  wompiResponse?: Record<string, any> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
