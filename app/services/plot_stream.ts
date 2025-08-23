import axios from 'axios'
import env from '#start/env'

type Generation = { raw: string; perSecond: number | null; ready: boolean }

type AnimalEmpty = { index: number | string; empty: true }
type AnimalFull = {
  index: number | string
  empty: false
  displayName: string
  mutation: string
  rarity: string
  generation: Generation
}

type AnimalPodium = AnimalEmpty | AnimalFull

type Plot = {
  plotSign: string
  remainingTime: { raw: string | null; seconds: number | null }
  animalPodiums: AnimalPodium[]
  meta: { timestamp: string }
}

type JobPayload = {
  jobId: string
  generatedAt: string
  plots: Plot[]
}

type FilterQuery = {
  mutation?: string
  rarity?: string
  minPerSecond?: number
}

export class PlotStream {
  private static instance: PlotStream
  private buffer: { at: number; jobId: string; generatedAt: string; plots: Plot[] }[] = []
  private ttlMs = 60_000

  // ====== UMBRALES Y COLORES ======
  private static MIN_NON_SECRET = 300_000 // >= 300k/s en TODOS los hooks
  private static RAINBOW_5M = 5_000_000 // 5M+
  private static COLOR_DEFAULT = 0x95a5a6
  private static COLOR_HAS_5M = 0x2ecc71 // color del embed si hay 5M en general
  private static COLOR_5M_ONLY = 0x0b63ff // color del embed para el hook 5M-only (sin bg en texto)

  // Límites Discord (se parte auto en varios embeds/mensajes)
  private static MAX_FIELDS_PER_EMBED = 25
  private static MAX_EMBEDS_PER_MESSAGE = 10
  private static MAX_FIELD_VALUE = 1024
  private static MAX_EMBED_CHARS = 5500

  static getInstance() {
    if (!this.instance) this.instance = new PlotStream()
    return this.instance
  }

  pushPayload(payload: JobPayload) {
    const now = Date.now()
    this.buffer.push({
      at: now,
      jobId: payload.jobId,
      generatedAt: payload.generatedAt,
      plots: payload.plots,
    })
    this.gc(now)
  }

  dump(): Plot[] {
    this.gc(Date.now())
    const out: Plot[] = []
    for (const chunk of this.buffer) out.push(...chunk.plots)
    return out
  }

  dumpJobs(): JobPayload[] {
    this.gc(Date.now())
    return this.buffer.map((b) => ({ jobId: b.jobId, generatedAt: b.generatedAt, plots: b.plots }))
  }

  private gc(now = Date.now()) {
    const minTs = now - this.ttlMs
    this.buffer = this.buffer.filter((e) => e.at >= minTs)
  }

  parseHumanMoney(input: string | number | undefined): number | null {
    if (input === undefined || input === null) return null
    if (typeof input === 'number') return Number.isFinite(input) ? input : null
    const raw = String(input).trim().toLowerCase()
    if (raw === '') return null
    const m = raw.match(/^(\d+(?:\.\d+)?)([kmbt])$/i)
    if (m) {
      const num = Number.parseFloat(m[1])
      const suf = m[2].toLowerCase()
      const mult =
        suf === 'k' ? 1e3 : suf === 'm' ? 1e6 : suf === 'b' ? 1e9 : suf === 't' ? 1e12 : 1
      return num * mult
    }
    const asNum = Number(raw)
    if (!Number.isNaN(asNum)) return asNum
    return null
  }

  filter(q: FilterQuery) {
    const min = q.minPerSecond ?? null
    const out: Array<{
      plotSign: string
      index: number | string
      displayName: string
      mutation: string
      rarity: string
      generation: { raw: string; perSecond: number | null }
      timestamp: string
    }> = []
    for (const chunk of this.buffer) {
      for (const plot of chunk.plots) {
        for (const a of plot.animalPodiums) {
          if ((a as AnimalEmpty).empty) continue
          const full = a as AnimalFull
          if (q.mutation && full.mutation !== q.mutation) continue
          if (q.rarity && full.rarity !== q.rarity) continue
          const psec = full.generation?.perSecond ?? null
          if (min !== null) {
            if (psec === null || psec < min) continue
          } else {
            if (psec === null) continue
          }
          out.push({
            plotSign: plot.plotSign,
            index: full.index,
            displayName: full.displayName,
            mutation: full.mutation,
            rarity: full.rarity,
            generation: { raw: full.generation.raw, perSecond: psec },
            timestamp: plot.meta.timestamp,
          })
        }
      }
    }
    return out
  }

  /**
   * Hooks:
   * - DISCORD_WEBHOOK_CARLOS: Secret + ≥300k
   * - DISCORD_WEBHOOK_TEST:   Secret + ≥300k
   * - DISCORD_WEBHOOK_5M:     SOLO ≥5M (sin background en texto, título +5M)
   */
  async emitToDiscord(jobId: string, plots: Plot[]) {
    const hookCarlos = env.get('DISCORD_WEBHOOK_CARLOS')
    const hookTest = env.get('DISCORD_WEBHOOK_TEST')
    const hook5m = env.get('DISCORD_WEBHOOK_5M')

    type Item = { name: string; p: number; plot: string; rarity?: string }
    const all: Item[] = []

    for (const plot of plots) {
      for (const ap of plot.animalPodiums) {
        const anyAp = ap as any
        if (anyAp.empty) continue
        const a = ap as AnimalFull
        const p = a.generation?.perSecond
        if (typeof p !== 'number') continue
        all.push({ name: a.displayName, p, plot: plot.plotSign, rarity: a.rarity })
      }
    }
    if (!all.length) return

    const eligible300k = all.filter(
      (i) => i.rarity === 'Secret' || i.p >= PlotStream.MIN_NON_SECRET
    )
    const only5m = all.filter((i) => i.p >= PlotStream.RAINBOW_5M)

    // === CARLOS / TEST: Secret + ≥300k ===
    if (eligible300k.length) {
      const embeds = this.buildEmbedsPretty(jobId, eligible300k, { tintHas5m: true })
      await this.postInChunks([hookCarlos, hookTest].filter(Boolean) as string[], embeds)
    }

    // === 5M ONLY: “+5M” sin fondo, texto blanco ===
    if (only5m.length && hook5m) {
      const embeds5m = this.buildEmbedsPretty(jobId, only5m, {
        forceEmbedColorBlue: true,
        fiveMSectionOnly: true,
      })
      await this.postInChunks([hook5m], embeds5m)
    }
  }

  // ===================== RENDER =====================
  private buildEmbedsPretty(
    jobId: string,
    itemsRaw: Array<{ name: string; p: number; plot: string; rarity?: string }>,
    opts?: {
      tintHas5m?: boolean // color verde si hay 5M en este embed
      forceEmbedColorBlue?: boolean // usar color azul fuerte (hook 5M)
      fiveMSectionOnly?: boolean // mostrar sección +5M arriba y NO mezclar 5M dentro de plots
    }
  ) {
    const items = [...itemsRaw].sort((a, b) => b.p - a.p)
    const has5m = items.some((i) => i.p >= PlotStream.RAINBOW_5M)

    // Resumen por rareza
    const counts = new Map<string, number>()
    for (const it of items)
      counts.set(
        it.rarity === 'Secret' ? 'Secretos' : (it.rarity ?? 'Otros'),
        (counts.get(it.rarity === 'Secret' ? 'Secretos' : (it.rarity ?? 'Otros')) ?? 0) + 1
      )
    const summaryBars: string[] = []
    if (counts.has('Secretos')) summaryBars.push(`Secretos ${counts.get('Secretos')}`)
    for (const [k, v] of [...counts.entries()]
      // eslint-disable-next-line @typescript-eslint/no-shadow
      .filter(([k]) => k !== 'Secretos')
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      summaryBars.push(`${k} ${v}`)
    }

    const top5m = items.filter((i) => i.p >= PlotStream.RAINBOW_5M)
    const rest = opts?.fiveMSectionOnly ? items.filter((i) => i.p < PlotStream.RAINBOW_5M) : items

    // Agrupar por plot (para “rest”)
    type Group = {
      secrets: Array<{ name: string; p: number }>
      normalsByRarity: Map<string, Array<{ name: string; p: number }>>
    }
    const byPlot = new Map<string, Group>()
    for (const it of rest) {
      const g = byPlot.get(it.plot) ?? { secrets: [], normalsByRarity: new Map() }
      if (it.rarity === 'Secret') {
        // @ts-ignore
        g.secrets.push({ name: it.name, p: it.p })
      } else {
        const r = it.rarity && it.rarity.trim() ? it.rarity : 'Otros'
        const arr = g.normalsByRarity.get(r) ?? []
        arr.push({ name: it.name, p: it.p })
        g.normalsByRarity.set(r, arr)
      }
      byPlot.set(it.plot, g)
    }

    const orderedPlots = [...byPlot.entries()].sort((a, b) => {
      const bestA = Math.max(
        0,
        ...a[1].secrets.map((x) => x.p),
        ...[...a[1].normalsByRarity.values()].flat().map((x) => x.p)
      )
      const bestB = Math.max(
        0,
        ...b[1].secrets.map((x) => x.p),
        ...[...b[1].normalsByRarity.values()].flat().map((x) => x.p)
      )
      return bestB - bestA
    })

    // ---- fields ----
    const fields: Array<{ name: string; value: string; inline?: boolean }> = []

    // +5M (sin fondo, texto blanco)
    if (top5m.length && opts?.fiveMSectionOnly) {
      const lines = top5m.map((i) =>
        this.ansiWhiteBold(` ¬ ${i.name} — ${this.human(i.p)}/s — ${i.plot} `)
      )
      fields.push({ name: '+5M', value: this.wrapAnsi(lines.join('\n')), inline: false })
    }

    for (const [plotName, group] of orderedPlots) {
      const lines: string[] = []

      // Secretos (líneas blancas)
      if (group.secrets.length) {
        const sec = [...group.secrets].sort((a, b) => b.p - a.p)
        const sLines = sec.map((it) => this.ansiWhiteBold(` ¬ ${it.name} — ${this.human(it.p)}/s `))
        lines.push('**Secretos**')
        lines.push(this.wrapAnsi(sLines.join('\n')))
      }

      // Rarities no-secret
      const orderedRarities = [...group.normalsByRarity.entries()].sort((a, b) => {
        const maxA = Math.max(...a[1].map((x) => x.p))
        const maxB = Math.max(...b[1].map((x) => x.p))
        return maxB - maxA
      })

      for (const [rarity, arr] of orderedRarities) {
        const arrSorted = [...arr].sort((a, b) => b.p - a.p)

        if (rarity === 'Brainrot God') {
          // Título “Brainrot God” arcoíris por letra; ítems sin color
          lines.push(this.wrapAnsi(this.ansiRainbowLetters('Brainrot God')))
          for (const it of arrSorted) lines.push(`¬ ${it.name} — \`${this.human(it.p)}/s\``)
        } else {
          // Título en amarillo; ítems sin color
          lines.push(this.wrapAnsi(this.ansiYellow(` ${rarity} `)))
          for (const it of arrSorted) lines.push(`¬ ${it.name} — \`${this.human(it.p)}/s\``)
        }
      }

      const value = lines.filter(Boolean).join('\n')
      if (value.trim().length) fields.push({ name: `• ${plotName}`, value, inline: false })
    }

    // JobId
    fields.push({ name: 'Job ID', value: `\`\`\`${jobId}\`\`\``, inline: false })

    // Embed meta
    const description = [
      `**TOTAL:** ${items.length}`,
      summaryBars.length ? summaryBars.join(' | ') : null,
    ]
      .filter(Boolean)
      .join('\n')
    const color = opts?.forceEmbedColorBlue
      ? PlotStream.COLOR_5M_ONLY
      : opts?.tintHas5m && has5m
        ? PlotStream.COLOR_HAS_5M
        : PlotStream.COLOR_DEFAULT

    return this.packEmbeds('PetNotify', description, color, fields)
  }

  // ---- Empaquetado por límites de Discord ----
  private packEmbeds(
    title: string,
    description: string,
    color: number,
    fields: Array<{ name: string; value: string; inline?: boolean }>
  ) {
    const embeds: any[] = []
    let current = this.newEmbed(title, description, color)
    let fieldCount = 0
    let chars = this.embedSize(current)

    for (const f of fields) {
      const chunks = this.chunkFieldValue(f.value, PlotStream.MAX_FIELD_VALUE)
      for (const [i, chunk] of chunks.entries()) {
        const name = i === 0 ? f.name : `${f.name} (cont.)`
        const field = { name, value: chunk, inline: false }
        const addSize = name.length + chunk.length + 10

        const wouldOverflow =
          fieldCount >= PlotStream.MAX_FIELDS_PER_EMBED ||
          chars + addSize > PlotStream.MAX_EMBED_CHARS
        if (wouldOverflow) {
          embeds.push(current)
          current = this.newEmbed(title + ` (cont.)`, description, color)
          fieldCount = 0
          chars = this.embedSize(current)
        }
        current.fields.push(field)
        fieldCount++
        chars += addSize
      }
    }
    if (current.fields.length) embeds.push(current)
    return embeds
  }

  private newEmbed(title: string, description: string, color: number) {
    return {
      title,
      color,
      description,
      fields: [] as any[],
      footer: { text: `SauPetNotify • ${new Date().toLocaleString()}` },
    }
  }

  private embedSize(e: any) {
    const fieldsLen = e.fields.reduce((a: number, f: any) => a + f.name.length + f.value.length, 0)
    return (e.title?.length ?? 0) + (e.description?.length ?? 0) + fieldsLen + 50
  }

  private chunkFieldValue(s: string, max: number) {
    if (s.length <= max) return [s]
    const out: string[] = []
    let i = 0
    while (i < s.length) {
      out.push(s.slice(i, i + max))
      i += max
    }
    return out
  }

  private async postInChunks(urls: string[], embeds: any[]) {
    if (!urls.length || !embeds.length) return
    for (const url of urls) {
      let i = 0
      while (i < embeds.length) {
        const slice = embeds.slice(i, i + PlotStream.MAX_EMBEDS_PER_MESSAGE)
        await this.safePost(url, { embeds: slice })
        i += PlotStream.MAX_EMBEDS_PER_MESSAGE
      }
    }
  }

  private async safePost(url: string, payload: any) {
    try {
      await axios.post(url, payload)
    } catch {}
  }

  // ---- ANSI helpers ----
  private wrapAnsi(s: string) {
    return '```ansi\n' + s + '\n```'
  }
  private ansiWhiteBold(s: string) {
    return '\u001b[1;97m' + s + '\u001b[0m'
  }
  private ansiYellow(s: string) {
    return '\u001b[33m' + s + '\u001b[0m'
  }

  // “Brainrot God” arcoíris por letra
  private ansiRainbowLetters(word: string) {
    const palette = [91, 93, 92, 96, 94, 95, 31, 33, 32, 36, 34, 35] // rojo, amarillo, verde, cian, azul, magenta (brights + normales)
    let out = ''
    let j = 0
    for (const ch of word.split('')) {
      if (ch === ' ') {
        out += ch
        continue
      }
      out += `\u001b[${palette[j % palette.length]}m${ch}\u001b[0m`
      j++
    }
    return out
  }

  private human(n: number): string {
    if (n >= 1e12) return `${+(n / 1e12).toFixed(3)}T`
    if (n >= 1e9) return `${+(n / 1e9).toFixed(3)}B`
    if (n >= 1e6) return `${+(n / 1e6).toFixed(3)}M`
    if (n >= 1e3) return `${+(n / 1e3).toFixed(3)}K`
    return `${+n.toFixed(3)}`
  }
}
