import { registerAs } from '@nestjs/config';

/**
 * Configuración de la pasarela de pagos Wompi (sandbox).
 * Las llaves nunca se escriben en el código: llegan por variables de entorno.
 */
export const wompiConfig = registerAs('wompi', () => ({
  publicKey: process.env.WOMPI_PUBLIC_KEY,
  privateKey: process.env.WOMPI_PRIVATE_KEY,
  eventsSecret: process.env.WOMPI_EVENTS_SECRET,
  integritySecret: process.env.WOMPI_INTEGRITY_SECRET,
  baseUrl:
    process.env.NODE_ENV === 'production'
      ? 'https://production.wompi.co/v1'
      : 'https://sandbox.wompi.co/v1',
  currency: 'COP',
}));
