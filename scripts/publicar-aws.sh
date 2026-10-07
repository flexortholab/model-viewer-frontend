#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Publica una web estatica compilada en un bucket S3 servido por CloudFront:
# sube los ficheros e invalida la cache de la distribucion que tiene el
# dominio como alias. Se niega a seguir si la sesion de AWS no es de la cuenta
# indicada.
#
# Uso:
#   scripts/publicar-aws.sh --cuenta <id> --bucket <nombre> --dominio <host> [--dist <carpeta>]
set -euo pipefail

readonly USO='Uso: scripts/publicar-aws.sh --cuenta <id> --bucket <nombre> --dominio <host> [--dist <carpeta>]'

DIST='dist'
AWS_ACCOUNT_ID=''
WEB_BUCKET=''
WEB_DOMAIN=''

fail() {
  echo "publicar-aws: $1" >&2
  exit 1
}

comprobar_cuenta() {
  local cuenta
  cuenta="$(aws sts get-caller-identity --query Account --output text)" ||
    fail 'no hay una sesion de AWS valida'
  [[ "$cuenta" == "$AWS_ACCOUNT_ID" ]] ||
    fail "la sesion de AWS es de la cuenta $cuenta, no de la $AWS_ACCOUNT_ID"
}

# assets/ lleva hash en el nombre: se cachea un ano y no se borra lo anterior,
# para que una pestana abierta con el HTML viejo siga cargando sus ficheros.
# El resto (HTML, samples, draco, basis) se revalida siempre.
subir_web() {
  aws s3 sync "$DIST/assets" "s3://$WEB_BUCKET/assets" \
    --cache-control 'public, max-age=31536000, immutable'
  aws s3 sync "$DIST" "s3://$WEB_BUCKET" --exclude 'assets/*' --delete \
    --cache-control 'no-cache'
  aws s3 cp "$DIST" "s3://$WEB_BUCKET" --recursive --exclude '*' --include '*.wasm' \
    --content-type application/wasm --cache-control 'no-cache'
}

id_distribucion() {
  aws cloudfront list-distributions --output text \
    --query "DistributionList.Items[?Aliases.Items && contains(Aliases.Items, '$WEB_DOMAIN')].Id | [0]"
}

invalidar_cache() {
  local distribucion
  distribucion="$(id_distribucion)"
  [[ -n "$distribucion" && "$distribucion" != None ]] ||
    fail "no hay ninguna distribucion de CloudFront con el alias $WEB_DOMAIN"
  aws cloudfront create-invalidation --distribution-id "$distribucion" --paths '/*'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dist) DIST="${2:?$USO}"; shift 2 ;;
    --cuenta) AWS_ACCOUNT_ID="${2:?$USO}"; shift 2 ;;
    --bucket) WEB_BUCKET="${2:?$USO}"; shift 2 ;;
    --dominio) WEB_DOMAIN="${2:?$USO}"; shift 2 ;;
    -h | --help) echo "$USO"; exit 0 ;;
    *) fail "argumento desconocido: $1. $USO" ;;
  esac
done
[[ -n "$AWS_ACCOUNT_ID" && -n "$WEB_BUCKET" && -n "$WEB_DOMAIN" ]] || fail "$USO"
readonly DIST AWS_ACCOUNT_ID WEB_BUCKET WEB_DOMAIN

[[ -f "$DIST/index.html" ]] || fail "no existe $DIST/index.html: falta el build"
comprobar_cuenta
subir_web
invalidar_cache
echo "Publicada en https://$WEB_DOMAIN"
