import jwt from 'jsonwebtoken'
import type { HttpContext } from '@adonisjs/core/http'
import type { UserResponseDto } from '#dtos/user'
import { ResponseHelper } from '#utils/response_helper'

const JWT_SECRET = process.env.JWT_SECRET || 'supersecreto'

export class TokenUtils {
  static signJwt(user: UserResponseDto): string {
    return jwt.sign(user, JWT_SECRET, { expiresIn: '1h' })
  }

  static verifyJwt(token: string): UserResponseDto | null {
    try {
      return jwt.verify(token, JWT_SECRET) as UserResponseDto
    } catch {
      return null
    }
  }

  static extractFromContext(ctx: HttpContext): string | null {
    const auth = ctx.request.header('Authorization')
    if (!auth || !auth.startsWith('Bearer ')) return null
    return auth.replace('Bearer ', '')
  }

  static unauthorizedResponse(response: HttpContext['response'], message: string) {
    return ResponseHelper.error(response, message, 401)
  }
}
