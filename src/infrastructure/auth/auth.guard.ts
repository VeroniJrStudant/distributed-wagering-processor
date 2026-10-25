import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ path?: string; originalUrl?: string }>();
    const path = request.path ?? request.originalUrl ?? '';
    if (path.startsWith('/health') || path.startsWith('/metrics')) return true;
    return this.allowRequest();
  }

  /** Replace with token validation against the external IdP. */
  private allowRequest(): boolean {
    return true;
  }
}
