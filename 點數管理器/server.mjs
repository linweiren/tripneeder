import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const PORT = Number(process.env.POINTS_MANAGER_PORT || 4174)
const HOST = 'localhost'
const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(TOOL_DIR, '..')
const ENV_PATH = resolve(PROJECT_ROOT, '.env')
const ADJUSTMENT_TYPE = 'admin_adjust'

const env = {
  ...parseEnvFile(await readOptionalFile(ENV_PATH)),
  ...process.env,
}

const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL || ''
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || ''

const supabase =
  supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      })
    : null

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res)
  } catch (error) {
    sendJson(res, 500, {
      error:
        error instanceof Error
          ? error.message
          : '點數管理器發生未知錯誤。',
    })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`點數管理器已啟動：http://${HOST}:${PORT}/`)
})

async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, renderPage())
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, {
      ready: Boolean(supabase),
      hasSupabaseUrl: Boolean(supabaseUrl),
      hasServiceRoleKey: Boolean(serviceRoleKey),
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/profiles') {
    ensureSupabase()
    const search = url.searchParams.get('search')?.trim() ?? ''
    const profiles = await listProfiles(search)
    sendJson(res, 200, { profiles })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/adjust') {
    ensureSupabase()
    const body = await readJsonBody(req)
    const result = await adjustPoints(body)
    sendJson(res, 200, result)
    return
  }

  sendJson(res, 404, { error: '找不到這個點數管理器路徑。' })
}

async function listProfiles(search) {
  let query = supabase
    .from('profiles')
    .select('id,email,display_name,points_balance,updated_at,created_at')
    .order('updated_at', { ascending: false })
    .limit(100)

  if (search) {
    const escapedSearch = search.replaceAll('%', '\\%').replaceAll('_', '\\_')
    query = query.or(
      `email.ilike.%${escapedSearch}%,display_name.ilike.%${escapedSearch}%`,
    )
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`讀取帳號失敗：${error.message}`)
  }

  return data ?? []
}

async function adjustPoints(body) {
  if (!isRecord(body)) {
    throw new Error('調整資料格式不正確。')
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
  const amount = Number(body.amount)
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : '點數管理器手動調整'

  if (!isUuid(userId)) {
    throw new Error('請先選擇要調整的帳號。')
  }

  if (!Number.isInteger(amount) || amount === 0) {
    throw new Error('調整點數必須是不等於 0 的整數。')
  }

  const { data: currentProfile, error: readError } = await supabase
    .from('profiles')
    .select('id,email,display_name,points_balance')
    .eq('id', userId)
    .single()

  if (readError || !currentProfile) {
    throw new Error(`讀取帳號點數失敗：${readError?.message ?? '找不到帳號'}`)
  }

  const currentBalance = Number(currentProfile.points_balance)
  const nextBalance = currentBalance + amount

  if (nextBalance < 0) {
    throw new Error(
      `點數不可低於 0。目前 ${currentBalance} 點，最多只能減少 ${currentBalance} 點。`,
    )
  }

  const { data: updatedProfile, error: updateError } = await supabase
    .from('profiles')
    .update({
      points_balance: nextBalance,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .select('id,email,display_name,points_balance,updated_at,created_at')
    .single()

  if (updateError || !updatedProfile) {
    throw new Error(`更新點數失敗：${updateError?.message ?? '找不到帳號'}`)
  }

  const { error: transactionError } = await supabase
    .from('point_transactions')
    .insert({
      user_id: userId,
      type: ADJUSTMENT_TYPE,
      amount,
      balance_after: nextBalance,
      reason,
      created_by: null,
    })

  if (transactionError) {
    throw new Error(
      `點數已更新，但交易紀錄寫入失敗：${transactionError.message}`,
    )
  }

  return {
    profile: updatedProfile,
    message: `已將 ${currentProfile.email} 的點數從 ${currentBalance} 調整為 ${nextBalance}。`,
  }
}

function renderPage() {
  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>點數管理器</title>
    <style>
      :root {
        color-scheme: light;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #26312f;
        background: #f4f6f1;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: #f4f6f1;
      }

      main {
        width: min(1040px, calc(100% - 32px));
        margin: 0 auto;
        padding: 40px 0;
      }

      h1,
      h2,
      p {
        margin: 0;
      }

      h1 {
        font-size: clamp(2rem, 5vw, 3.5rem);
        line-height: 1.05;
      }

      .intro {
        display: grid;
        gap: 12px;
        margin-bottom: 28px;
      }

      .intro p,
      .hint,
      .muted {
        color: #68736d;
        line-height: 1.7;
      }

      .panel {
        background: #ffffff;
        border: 1px solid #dce3dd;
        border-radius: 8px;
        padding: 20px;
        box-shadow: 0 20px 40px rgba(42, 55, 50, 0.08);
      }

      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
        gap: 20px;
      }

      .toolbar,
      .form-row,
      .actions {
        display: flex;
        gap: 10px;
      }

      .toolbar {
        margin-bottom: 14px;
      }

      input,
      textarea,
      button {
        font: inherit;
      }

      input,
      textarea {
        width: 100%;
        border: 1px solid #cfd8d1;
        border-radius: 8px;
        padding: 12px 14px;
        background: #fbfcfa;
        color: #26312f;
      }

      textarea {
        min-height: 92px;
        resize: vertical;
      }

      button {
        border: 0;
        border-radius: 8px;
        padding: 12px 16px;
        background: #2f6b57;
        color: #ffffff;
        cursor: pointer;
        white-space: nowrap;
      }

      button.secondary {
        background: #dfe8e2;
        color: #26312f;
      }

      button.danger {
        background: #a9473d;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      .profiles {
        display: grid;
        gap: 10px;
        max-height: 580px;
        overflow: auto;
        padding-right: 4px;
      }

      .profile-button {
        width: 100%;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        text-align: left;
        background: #f8faf7;
        color: #26312f;
        border: 1px solid #dde5df;
      }

      .profile-button.active {
        border-color: #2f6b57;
        background: #eaf3ee;
      }

      .profile-email {
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .balance {
        font-size: 1.5rem;
        font-weight: 800;
      }

      .selected {
        display: grid;
        gap: 16px;
      }

      .selected-card {
        display: grid;
        gap: 8px;
        padding: 16px;
        background: #f8faf7;
        border: 1px solid #dde5df;
        border-radius: 8px;
      }

      .status {
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: 8px;
        background: #edf5ef;
        color: #285744;
        line-height: 1.6;
      }

      .status.error {
        background: #faece9;
        color: #8d3129;
      }

      .setup {
        display: none;
        margin-bottom: 20px;
      }

      .setup.show {
        display: block;
      }

      code {
        background: #edf0eb;
        border-radius: 6px;
        padding: 2px 6px;
      }

      @media (max-width: 780px) {
        main {
          width: min(100% - 24px, 1040px);
          padding: 24px 0;
        }

        .grid,
        .toolbar,
        .form-row,
        .actions {
          grid-template-columns: 1fr;
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="intro">
        <p class="muted">Tripneeder 本機工具</p>
        <h1>點數管理器</h1>
        <p>選擇已登入過的帳號，手動增加或減少點數。減少點數最低只能到 0，每次調整都會留下管理調整紀錄。</p>
      </section>

      <section id="setup" class="panel setup">
        <h2>需要補環境變數</h2>
        <p class="hint">請在專案根目錄 <code>.env</code> 加入 <code>SUPABASE_SERVICE_ROLE_KEY</code>，並保留 <code>SUPABASE_URL</code>。service role key 不可使用 <code>VITE_</code> 開頭。</p>
      </section>

      <section class="grid">
        <div class="panel">
          <div class="toolbar">
            <input id="search" type="search" placeholder="搜尋 email 或名稱" />
            <button id="reload" type="button" class="secondary">重新整理</button>
          </div>
          <div id="profiles" class="profiles" aria-live="polite"></div>
        </div>

        <div class="panel selected">
          <div>
            <h2>調整點數</h2>
            <p class="hint">先從左側選擇帳號，再輸入要增加或減少的點數。</p>
          </div>

          <div id="selected" class="selected-card">
            <p class="muted">尚未選擇帳號</p>
          </div>

          <label>
            <span class="muted">點數數量</span>
            <input id="amount" type="number" inputmode="numeric" min="1" step="1" placeholder="例如 100" />
          </label>

          <label>
            <span class="muted">原因</span>
            <textarea id="reason">點數管理器手動調整</textarea>
          </label>

          <div class="actions">
            <button id="increase" type="button">增加點數</button>
            <button id="decrease" type="button" class="danger">減少點數</button>
          </div>

          <div id="status" class="status" hidden></div>
        </div>
      </section>
    </main>

    <script>
      const state = {
        profiles: [],
        selected: null,
      }

      const setup = document.querySelector('#setup')
      const profilesEl = document.querySelector('#profiles')
      const selectedEl = document.querySelector('#selected')
      const searchEl = document.querySelector('#search')
      const reloadEl = document.querySelector('#reload')
      const amountEl = document.querySelector('#amount')
      const reasonEl = document.querySelector('#reason')
      const increaseEl = document.querySelector('#increase')
      const decreaseEl = document.querySelector('#decrease')
      const statusEl = document.querySelector('#status')

      init()

      async function init() {
        await checkStatus()
        await loadProfiles()

        reloadEl.addEventListener('click', loadProfiles)
        searchEl.addEventListener('input', debounce(loadProfiles, 300))
        increaseEl.addEventListener('click', () => submitAdjustment(1))
        decreaseEl.addEventListener('click', () => submitAdjustment(-1))
      }

      async function checkStatus() {
        const response = await fetch('/api/status')
        const data = await response.json()

        setup.classList.toggle('show', !data.ready)
        setActionsEnabled(data.ready)
      }

      async function loadProfiles() {
        try {
          const search = encodeURIComponent(searchEl.value.trim())
          const response = await fetch('/api/profiles?search=' + search)
          const data = await response.json()

          if (!response.ok) {
            throw new Error(data.error || '讀取帳號失敗')
          }

          state.profiles = data.profiles
          renderProfiles()
          syncSelectedProfile()
        } catch (error) {
          showStatus(error.message, true)
        }
      }

      function renderProfiles() {
        if (state.profiles.length === 0) {
          profilesEl.innerHTML = '<p class="hint">沒有找到已登入過的帳號。</p>'
          return
        }

        profilesEl.innerHTML = state.profiles
          .map((profile) => {
            const active = state.selected?.id === profile.id ? ' active' : ''
            return '<button class="profile-button' + active + '" type="button" data-id="' + escapeHtml(profile.id) + '">' +
              '<span><span class="profile-email">' + escapeHtml(profile.email) + '</span><br /><span class="muted">' + escapeHtml(profile.display_name || '未提供名稱') + '</span></span>' +
              '<span class="balance">' + Number(profile.points_balance).toLocaleString('zh-TW') + '</span>' +
            '</button>'
          })
          .join('')

        profilesEl.querySelectorAll('button').forEach((button) => {
          button.addEventListener('click', () => {
            state.selected = state.profiles.find((profile) => profile.id === button.dataset.id) || null
            renderProfiles()
            renderSelected()
            hideStatus()
          })
        })
      }

      function syncSelectedProfile() {
        if (!state.selected) {
          renderSelected()
          return
        }

        const latest = state.profiles.find((profile) => profile.id === state.selected.id)
        state.selected = latest || state.selected
        renderSelected()
      }

      function renderSelected() {
        if (!state.selected) {
          selectedEl.innerHTML = '<p class="muted">尚未選擇帳號</p>'
          return
        }

        selectedEl.innerHTML =
          '<p class="profile-email">' + escapeHtml(state.selected.email) + '</p>' +
          '<p class="muted">' + escapeHtml(state.selected.display_name || '未提供名稱') + '</p>' +
          '<p><span class="muted">目前點數</span><br /><span class="balance">' + Number(state.selected.points_balance).toLocaleString('zh-TW') + '</span></p>'
      }

      async function submitAdjustment(sign) {
        try {
          if (!state.selected) {
            throw new Error('請先選擇帳號。')
          }

          const rawAmount = Number(amountEl.value)

          if (!Number.isInteger(rawAmount) || rawAmount <= 0) {
            throw new Error('請輸入大於 0 的整數。')
          }

          const amount = rawAmount * sign
          const nextBalance = Number(state.selected.points_balance) + amount

          if (nextBalance < 0) {
            throw new Error('點數不可低於 0。')
          }

          setActionsEnabled(false)
          hideStatus()

          const response = await fetch('/api/adjust', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              userId: state.selected.id,
              amount,
              reason: reasonEl.value,
            }),
          })
          const data = await response.json()

          if (!response.ok) {
            throw new Error(data.error || '調整點數失敗')
          }

          state.selected = data.profile
          amountEl.value = ''
          showStatus(data.message)
          await loadProfiles()
        } catch (error) {
          showStatus(error.message, true)
        } finally {
          setActionsEnabled(true)
        }
      }

      function setActionsEnabled(enabled) {
        reloadEl.disabled = !enabled
        increaseEl.disabled = !enabled
        decreaseEl.disabled = !enabled
      }

      function showStatus(message, isError = false) {
        statusEl.hidden = false
        statusEl.textContent = message
        statusEl.classList.toggle('error', isError)
      }

      function hideStatus() {
        statusEl.hidden = true
        statusEl.textContent = ''
        statusEl.classList.remove('error')
      }

      function debounce(callback, delay) {
        let timer = 0
        return () => {
          window.clearTimeout(timer)
          timer = window.setTimeout(callback, delay)
        }
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#039;')
      }
    </script>
  </body>
</html>`
}

function ensureSupabase() {
  if (!supabase) {
    throw new Error(
      '尚未設定 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，請先查看點數管理器 README。',
    )
  }
}

async function readJsonBody(req) {
  const chunks = []

  for await (const chunk of req) {
    chunks.push(chunk)
  }

  const rawBody = Buffer.concat(chunks).toString('utf8')

  if (!rawBody) {
    return null
  }

  return JSON.parse(rawBody)
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(html)
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

function parseEnvFile(content) {
  const result = {}

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')

    if (separatorIndex < 1) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^"|"$/g, '')
    result[key] = value
  }

  return result
}

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}
