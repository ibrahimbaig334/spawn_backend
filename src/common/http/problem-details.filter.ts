import { randomUUID } from 'node:crypto';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DomainException } from './domain.exception';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  code: string;
  requestId: string;
  errors?: unknown;
  [extension: string]: unknown;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const status =
      exception instanceof DomainException
        ? exception.status
        : exception instanceof HttpException
          ? exception.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;
    const response =
      exception instanceof DomainException
        ? { code: exception.code, message: exception.message, errors: exception.errors }
        : exception instanceof HttpException
          ? exception.getResponse()
          : undefined;
    const requestId = request.id || randomUUID();
    const details = this.extractDetails(response);

    if (status >= 500) {
      const message = exception instanceof Error ? exception.message : 'Unknown error';
      this.logger.error(`${request.method} ${request.url} -> ${status}: ${message}`);
    }

    const body: ProblemDetails = {
      type: `https://api.spawn.local/problems/${details.code.toLowerCase()}`,
      title: this.title(status),
      status,
      detail: details.detail,
      instance: request.url,
      code: details.code,
      requestId,
      errors: details.errors,
      ...details.extensions,
    };

    void reply.status(status).type('application/problem+json').send(body);
  }

  private extractDetails(response: string | object | undefined): {
    code: string;
    detail?: string;
    errors?: unknown;
    extensions?: Record<string, unknown>;
  } {
    if (typeof response === 'string') return { code: 'HTTP_ERROR', detail: response };
    if (response && 'code' in response && typeof response.code === 'string') {
      const message = 'message' in response ? response.message : undefined;
      const errors = 'errors' in response ? response.errors : undefined;
      const checks = 'checks' in response ? response.checks : undefined;
      return {
        code: response.code,
        detail: typeof message === 'string' ? message : undefined,
        errors: errors ?? (Array.isArray(message) ? message : undefined),
        extensions: checks === undefined ? undefined : { checks },
      };
    }
    if (response && 'message' in response) {
      const message = response.message;
      return {
        code: 'VALIDATION_FAILED',
        detail: typeof message === 'string' ? message : 'Request validation failed',
        errors: Array.isArray(message) ? message : undefined,
      };
    }
    return { code: 'INTERNAL_ERROR', detail: 'An unexpected error occurred' };
  }

  private title(status: number): string {
    return HttpStatus[status]?.replaceAll('_', ' ').toLowerCase() ?? 'error';
  }
}
