import path from 'node:path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Gera .next/standalone com um server.js proprio: e o que a imagem Docker roda.
  output: 'standalone',
  // Raiz do monorepo: sem isto o trace nao alcanca packages/shared nem o
  // node_modules da raiz do workspace.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // @clinicas/shared e distribuido como fonte compilada do monorepo, nao publicado.
  transpilePackages: ['@clinicas/shared'],
}

export default nextConfig
