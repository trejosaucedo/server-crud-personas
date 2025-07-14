import { MongoClient } from 'mongodb'
import type { AuditoriaLogDto } from '#dtos/auditoria'

const uri = process.env.MONGO_URL || 'mongodb://localhost:27017'
const dbName = process.env.MONGO_DB || 'crud-personas'
const collectionName = 'auditoria_personas'

export async function registrarAuditoria(data: AuditoriaLogDto): Promise<void> {
  const client = new MongoClient(uri)
  try {
    await client.connect()
    const db = client.db(dbName)
    const collection = db.collection(collectionName)
    await collection.insertOne(data)
  } finally {
    await client.close().catch(() => {})
  }
}

export async function obtenerAuditorias(filtro: object = {}): Promise<AuditoriaLogDto[]> {
  const client = new MongoClient(uri)
  try {
    await client.connect()
    const db = client.db(dbName)
    const collection = db.collection(collectionName)
    const results = await collection.find(filtro).toArray()
    return results.map((doc) => ({
      accion: doc.accion,
      entidad: doc.entidad,
      personaId: doc.personaId,
      fecha: doc.fecha,
      datos: doc.datos,
      usuario: doc.usuario,
    }))
  } finally {
    await client.close().catch(() => {})
  }
}
