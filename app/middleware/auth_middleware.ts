import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { TokenUtils } from '#utils/token_utils'

export default class AuthMiddleware {
  public async handle(ctx: HttpContext, next: NextFn) {
    const token = TokenUtils.extractFromContext(ctx)
    if (!token) {
      return TokenUtils.unauthorizedResponse(ctx.response, 'Token requerido')
    }
    const user = TokenUtils.verifyJwt(token)
    if (!user) {
      return TokenUtils.unauthorizedResponse(ctx.response, 'Token inválido o expirado')
    }
    ctx.user = user
    return next()
  }
}
