#!/bin/bash
set -e
echo "==========================================="
echo "   ATUALIZADOR DO SENTINELA"
echo "==========================================="
echo ""
echo "[1/2] Puxando atualizações do GitHub..."
git pull origin main
echo ""
echo "[2/2] Instalando pacotes e compilando o Visual (Frontend Vite)..."
docker run --rm -v $(pwd):/app -w /app node:20-alpine sh -c "npm install && npm run build"
echo ""
echo "==========================================="
echo "   Atualização concluída com sucesso!"
echo "==========================================="