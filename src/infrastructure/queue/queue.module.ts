import { Global, Module } from '@nestjs/common';
import { OutboxDispatcher } from './outbox-dispatcher';

@Global()
@Module({
  providers: [OutboxDispatcher],
  exports: [OutboxDispatcher],
})
export class QueueModule {}
