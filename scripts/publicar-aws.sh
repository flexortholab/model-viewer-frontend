#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Publica la web compilada en https://viewer.flexortholab.com (S3 +
# CloudFront; la infraestructura esta en model-viewer-backend). Lo ejecuta el
# CI en el push a main, con el rol model-viewer-prod-web-deploy.
#
# Uso: scripts/publicar-aws.sh [carpeta]   (por defecto, dist)
set -euo pipefail

readonly DIST="${1:-dist}"
readonly AWS_ACCOUNT_ID='576951332538'
readonly WEB_BUCKET="model-viewer-prod-web-${AWS_ACCOUNT_ID}"
readonly WEB_DOMAIN='viewer.flexortholab.com'

fail() {
  echo "publicar-aws: $1" >&2
  exit 1
}

comprobar_cuenta() {
  local cuenta
  cuenta="$(aws sts get-caller-identity --query Account --output text)" ||
    fail 'no hay una sesion de AWS valida'
  [[ "$cuenta" == "$AWS_ACCOUNT_ID" ]] ||
    fail "la sesion de AWS es de la cuenta $cuenta, no de la del visor ($AWS_ACCOUNT_ID)"
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

[[ -f "$DIST/index.html" ]] || fail "no existe $DIST/index.html: falta npm run build"
comprobar_cuenta
subir_web
invalidar_cache
echo "Publicada en https://$WEB_DOMAIN"
