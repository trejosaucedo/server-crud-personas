# API CRUD Server

API REST completa para gestión de personas con autenticación y dashboard de estadísticas.

## 🚀 Características

- **Autenticación**: Sistema de login/logout con tokens
- **CRUD de Personas**: Operaciones completas de Create, Read, Update, Delete
- **Dashboard**: Estadísticas detalladas de personas
- **Prefijo API**: Todas las rutas tienen prefijo `/api`
- **Base de datos**: MySQL con migraciones y seeders

## 📋 Requisitos

- Node.js 18+
- MySQL
- npm o yarn

## 🛠️ Instalación

1. **Clonar el repositorio**
```bash
git clone <tu-repositorio>
cd crud-server
```

2. **Instalar dependencias**
```bash
npm install
```

3. **Configurar base de datos**
```bash
# Copiar archivo de configuración
cp .env.example .env

# Editar .env con tus credenciales de MySQL
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=tu_usuario
DB_PASSWORD=tu_password
DB_DATABASE=crud_server
```

4. **Ejecutar migraciones**
```bash
node ace migration:run
```

5. **Ejecutar seeders**
```bash
node ace db:seed
```

6. **Iniciar servidor**
```bash
npm run dev
```

El servidor estará disponible en `http://localhost:3333`

## 📚 Documentación de la API

### Base URL
```
http://localhost:3333/api
```

### Autenticación

#### POST /api/login
Iniciar sesión con email y password.

**Body:**
```json
{
  "email": "saulsanchezlopez999@gmail.com",
  "password": "12345678"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login exitoso",
  "data": {
    "user": {
      "id": 1,
      "name": "Saúl Sánchez",
      "email": "saulsanchezlopez999@gmail.com"
    },
    "token": "base64_encoded_token"
  }
}
```

#### POST /api/logout
Cerrar sesión.

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "message": "Logout exitoso"
}
```

#### GET /api/me
Obtener información del usuario autenticado.

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Saúl Sánchez",
    "email": "saulsanchezlopez999@gmail.com",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### Personas (CRUD)

#### GET /api/personas
Obtener lista de personas con paginación.

**Query Parameters:**
- `page`: Número de página (default: 1)
- `limit`: Elementos por página (default: 10)

**Response:**
```json
{
  "success": true,
  "data": {
    "meta": {
      "total": 50,
      "per_page": 10,
      "current_page": 1,
      "last_page": 5
    },
    "data": [
      {
        "id": 1,
        "nombre": "Juan",
        "apellido_paterno": "Pérez",
        "apellido_materno": "García",
        "edad": 25,
        "genero": "hombre",
        "created_at": "2024-01-01T00:00:00.000Z",
        "updated_at": "2024-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

#### POST /api/personas
Crear una nueva persona.

**Body:**
```json
{
  "nombre": "María",
  "apellido_paterno": "López",
  "apellido_materno": "Martínez",
  "edad": 30,
  "genero": "mujer"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Persona creada exitosamente",
  "data": {
    "id": 2,
    "nombre": "María",
    "apellido_paterno": "López",
    "apellido_materno": "Martínez",
    "edad": 30,
    "genero": "mujer",
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-01T00:00:00.000Z"
  }
}
```

#### GET /api/personas/:id
Obtener una persona específica.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "nombre": "Juan",
    "apellido_paterno": "Pérez",
    "apellido_materno": "García",
    "edad": 25,
    "genero": "hombre",
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-01T00:00:00.000Z"
  }
}
```

#### PUT /api/personas/:id
Actualizar una persona.

**Body:**
```json
{
  "nombre": "Juan Carlos",
  "edad": 26
}
```

**Response:**
```json
{
  "success": true,
  "message": "Persona actualizada exitosamente",
  "data": {
    "id": 1,
    "nombre": "Juan Carlos",
    "apellido_paterno": "Pérez",
    "apellido_materno": "García",
    "edad": 26,
    "genero": "hombre",
    "created_at": "2024-01-01T00:00:00.000Z",
    "updated_at": "2024-01-01T00:00:00.000Z"
  }
}
```

#### DELETE /api/personas/:id
Eliminar una persona.

**Response:**
```json
{
  "success": true,
  "message": "Persona eliminada exitosamente"
}
```

### Dashboard

#### GET /api/dashboard
Obtener estadísticas del dashboard.

**Response:**
```json
{
  "success": true,
  "data": {
    "totalPersonas": 50,
    "totalHombres": 25,
    "totalMujeres": 25,
    "menoresEdad": 10,
    "mayoresEdad": 40,
    "mujeresMayores": 20,
    "mujeresMenores": 5,
    "hombresMayores": 20,
    "hombresMenores": 5,
    "porcentajes": {
      "hombres": 50,
      "mujeres": 50,
      "menores": 20,
      "mayores": 80,
      "mujeres_mayores": 40,
      "mujeres_menores": 10,
      "hombres_mayores": 40,
      "hombres_menores": 10
    }
  }
}
```

## 🗄️ Estructura de la Base de Datos

### Tabla: users
- `id` (int, primary key)
- `name` (varchar)
- `email` (varchar, unique)
- `password` (varchar, hashed)
- `created_at` (timestamp)
- `updated_at` (timestamp)

### Tabla: personas
- `id` (int, primary key)
- `nombre` (varchar)
- `apellido_paterno` (varchar)
- `apellido_materno` (varchar)
- `edad` (int)
- `genero` (varchar) - valores: 'hombre', 'mujer'
- `created_at` (timestamp)
- `updated_at` (timestamp)

## 🔧 Comandos Útiles

```bash
# Ejecutar migraciones
node ace migration:run

# Revertir migraciones
node ace migration:rollback

# Ejecutar seeders
node ace db:seed

# Limpiar base de datos y ejecutar seeders
node ace migration:fresh --seed

# Ver rutas disponibles
node ace list:routes
```

## 📝 Notas

- La autenticación usa tokens simples en base64 (en producción usar JWT)
- Todas las respuestas siguen el formato estándar con `success` y `data/message`
- Los errores devuelven códigos HTTP apropiados y mensajes descriptivos
- La paginación está implementada en el endpoint de personas

## 🚀 Usuarios de Prueba

Después de ejecutar los seeders, tendrás estos usuarios disponibles:

1. **Administrador:**
   - Email: `saulsanchezlopez999@gmail.com`
   - Password: `12345678`

2. **Usuarios de prueba:**
   - Email: `usuario1@example.com` - Password: `password`
   - Email: `usuario2@example.com` - Password: `password`
   - etc. 