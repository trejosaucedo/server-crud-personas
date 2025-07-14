// Requests
export interface RegisterUserRequestDto {
  name: string
  email: string
  password: string
}

export interface LoginUserRequestDto {
  email: string
  password: string
}

// Responses
export interface UserResponseDto {
  id: string
  name: string
  email: string
}

export interface RegisterUserResponseDto {
  user: UserResponseDto
}

export interface LoginUserResponseDto {
  user: UserResponseDto
  token: string
}
