import User from '#models/user'
import type { RegisterUserRequestDto } from '#dtos/user'

export class UserRepository {
  async findByEmail(email: string) {
    return User.findBy('email', email)
  }

  async findById(id: string) {
    return User.find(id)
  }

  async create(data: RegisterUserRequestDto) {
    return User.create(data)
  }
}
