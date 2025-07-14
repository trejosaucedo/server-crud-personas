import '@adonisjs/core/http'
import type { UserResponseDto } from '#dtos/user'

declare module '@adonisjs/core/http' {
  interface HttpContext {
    user?: UserResponseDto
  }
}
