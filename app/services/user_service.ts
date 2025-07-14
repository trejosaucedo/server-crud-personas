import { UserRepository } from '#repositories/user_repository'
import hash from '@adonisjs/core/services/hash'
import { TokenUtils } from '#utils/token_utils'
import type {
  RegisterUserRequestDto,
  RegisterUserResponseDto,
  LoginUserRequestDto,
  LoginUserResponseDto,
  UserResponseDto,
} from '#dtos/user'

export class UserService {
  private repo = new UserRepository()

  async register(dto: RegisterUserRequestDto): Promise<RegisterUserResponseDto> {
    const user = await this.repo.create(dto)
    const userResponse: UserResponseDto = {
      id: user.id,
      name: user.name,
      email: user.email,
    }
    return { user: userResponse }
  }

  async login(dto: LoginUserRequestDto): Promise<LoginUserResponseDto | null> {
    const user = await this.repo.findByEmail(dto.email)
    if (!user) return null

    const isValidPassword = await hash.verify(user.password, dto.password)
    if (!isValidPassword) return null

    const userResponse: UserResponseDto = {
      id: user.id,
      name: user.name,
      email: user.email,
    }
    const token = TokenUtils.signJwt(userResponse)
    return { user: userResponse, token }
  }

  async getMe(userId: string): Promise<UserResponseDto | null> {
    const user = await this.repo.findById(userId)
    if (!user) return null
    return {
      id: user.id,
      name: user.name,
      email: user.email,
    }
  }
}
