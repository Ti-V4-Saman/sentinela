#!/bin/bash
set -e
echo "==========================================="
echo "   ATUALIZADOR DO SENTINELA"
echo "==========================================="
echo ""
echo "[1/2] Puxando atualizações do GitHub..."
git pull origin main
echo ""
echo "[2/2] Instalando pacotes, compilando o Visual e subindo o Backend..."
docker-compose up -d --build
echo ""
echo "==========================================="
echo "   Atualização concluída com sucesso!"
echo "==========================================="