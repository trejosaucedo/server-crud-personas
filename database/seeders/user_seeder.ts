// database/seeders/UserSeeder.ts

import { BaseSeeder } from '@adonisjs/lucid/seeders'
import User from '#models/user'

export default class UserSeeder extends BaseSeeder {
  public async run() {
    // Usuario administrador
    await User.create({
      name: 'Saúl Sánchez',
      email: 'saulsanchezlopez999@gmail.com',
      password: '12345678',
    })

    // Usuarios de prueba
    for (let i = 0; i < 5; i++) {
      await User.create({
        name: `Usuario ${i + 1}`,
        email: `usuario${i + 1}@example.com`,
        password: 'password',
      })
    }
  }
}
