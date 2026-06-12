import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TopupsService } from './topups.service';
import { WompiService } from '../wompi/wompi.service';
import { CreateTopupDto } from './dto/create-topup.dto';
import { WalletTopup } from './entities/wallet-topup.entity';

@ApiTags('Wallet')
@ApiHeader({
  name: 'x-user-id',
  description: 'ID del usuario autenticado (lo inyecta el API Gateway).',
  required: true,
  example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
})
@Controller('wallet/topups')
export class TopupsController {
  constructor(
    private readonly topupsService: TopupsService,
    private readonly wompiService: WompiService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Historial de recargas de mi billetera.',
  })
  async getMyTopups(@CurrentUser() userId: string): Promise<WalletTopup[]> {
    return this.topupsService.getTopupsByUserId(userId);
  }

  @Post()
  @ApiOperation({
    summary: 'Iniciar una recarga de la billetera.',
    description:
      'Crea el topup PENDING y la transacción en Wompi. El saldo NO se acredita aquí, ' +
      'solo cuando el webhook de Wompi confirma el pago.',
  })
  async createTopup(
    @CurrentUser() userId: string,
    @Body() dto: CreateTopupDto,
  ) {
    // IMPORTANTE FRONTEND: antes de recargar, mostrar un modal de confirmación que
    // advierta que las recargas no tienen reembolso y preguntar si está seguro de
    // realizar la acción.
    return this.topupsService.createTopup(userId, dto);
  }

  @Get('pse-institutions')
  @ApiOperation({
    summary: 'Lista de bancos disponibles para pago PSE.',
    description:
      'Devuelve los bancos habilitados en Wompi para PSE. Usar ' +
      'financial_institution_code al crear un topup con método PSE.',
  })
  async getPseInstitutions(): Promise<Record<string, unknown>[]> {
    return this.wompiService.getFinancialInstitutions();
  }
}
