import { Module } from '@nestjs/common';
import { RpcProxyController } from './rpc-proxy.controller';

@Module({
  controllers: [RpcProxyController],
})
export class RpcModule {}
