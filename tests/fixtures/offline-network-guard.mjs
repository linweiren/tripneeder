import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'
for (const key of Object.keys(process.env)) {
  if (/KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|SUPABASE_URL|VITE_SUPABASE/i.test(key)) delete process.env[key]
}
const deny = () => { throw new Error('Acceptance guard: external network disabled') }
globalThis.fetch = deny
http.request = deny
http.get = deny
https.request = deny
https.get = deny
net.connect = deny
net.createConnection = deny
tls.connect = deny
syncBuiltinESMExports()
