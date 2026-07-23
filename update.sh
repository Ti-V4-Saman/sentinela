#!/bin/bash
set -e
echo "==========================================="
echo "   ATUALIZADOR DO SENTINELA"
echo "==========================================="
echo ""
echo "[1/3] Puxando atualizações do GitHub..."
git pull origin main

echo ""
echo "[2/3] Instalando dependências e compilando o Frontend..."
npm install
npm run build

echo ""
echo "[3/3] Copiando o Frontend compilado para o Nginx e (re)iniciando o Backend..."
cp -r dist/. /home/sentinela/dist/
docker rm -f sentinella_dashboard_app 2>/dev/null || true
docker-compose up -d --build

echo ""
echo "==========================================="
echo "   Atualização concluída com sucesso!"
echo "   Frontend atualizado em /home/sentinela/dist"
echo "   Backend rodando na porta 3005"
echo "==========================================="