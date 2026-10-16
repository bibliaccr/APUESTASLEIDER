# Picks de fútbol

Web estática en GitHub Pages. Un workflow de GitHub Actions consulta
[API-Football](https://www.api-football.com/documentation-v3) dos veces al día,
guarda los resultados en `data/*.json` y la web solo lee esos archivos.
La clave está escrita en `scripts/actualizar.py` (variable `CLAVE_API`). Solo la usa ese
script en GitHub Actions; la web nunca la carga, pero si el repo es público cualquiera puede verla en el código.

## Niveles de confianza

| Nivel | 1X2 (gana X) | Doble oportunidad (X gana o empata) |
|---|---|---|
| Súper confiada | 70 % o más | 88 % o más |
| Confiada | 60 a 69 % | 80 a 87 % |
| Medianamente confiada | 50 a 59 % | 72 a 79 % |

Si la forma reciente del equipo elegido es peor que la del rival, el pick baja un nivel.
Los umbrales se cambian en `config.json`. La pestaña **Historial de aciertos** compara
el rendimiento real de cada nivel, para saber si los umbrales sirven.

## Puesta en marcha

1. Crea un repositorio en GitHub (vacío, sin README).
2. Sube estos archivos:
   ```bash
   cd picks-futbol
   git init
   git add .
   git commit -m "Primer commit"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
   git push -u origin main
   ```
3. (Opcional) Si prefieres un secreto en vez de la clave en el código: **Settings > Secrets and
   variables > Actions**, crea `API_FOOTBALL_KEY` y añade al paso del workflow
   `env: API_FOOTBALL_KEY: ${{ secrets.API_FOOTBALL_KEY }}`.
4. Activa la web: **Settings > Pages > Build and deployment**
   - Source: *Deploy from a branch*, rama `main`, carpeta `/ (root)`.
5. Corre el primer análisis: pestaña **Actions > Actualizar picks > Run workflow**.
6. Cuando termine (unos 5 a 10 minutos por las pausas entre llamadas), abre
   `https://TU_USUARIO.github.io/TU_REPO/`.

Después se actualiza solo a las 6:00 a. m. y 6:00 p. m. (hora Colombia).

## Cupo de la API (plan gratis: 100 llamadas al día)

Cada ejecución usa como máximo `max_llamadas` (48 por defecto, dos ejecuciones = 96).
Gasta así: 1 llamada por liga para el calendario, 1 por partido nuevo para la
predicción y 1 por cada 20 partidos terminados para los resultados.
Las predicciones se guardan en `data/cache_predicciones.json` y no se piden dos veces el mismo día.
Si agregas ligas, el cupo se reparte entre más partidos y algunos quedarán para la
siguiente ejecución.

## Cambiar ligas

Edita `config.json`. Los IDs de liga están en el panel de api-sports, o con
`GET /leagues?search=nombre`. IDs usados: Premier League 39, LaLiga 140,
Champions League 2, Liga BetPlay 239, Copa Libertadores 13.
`tipo_temporada` es `europea` (empieza en julio, ej. 2026 = 2026/27) o `anual`.

## Si algo falla

- **El workflow dice "Falta la clave"**: revisa que `CLAVE_API` en `scripts/actualizar.py` no esté vacía.
- **La web dice "Aún sin datos"**: el workflow no ha corrido todavía o terminó con error. Mira los logs en Actions.
- **Aparece un aviso de la API en la web**: la API devolvió un error. El más probable en plan gratis es no tener acceso a la temporada actual de una liga.
- **El workflow corre pero la web no cambia**: espera 1 o 2 minutos a que Pages republique.
- **Probar en tu computador**: `python3 -m http.server` en la carpeta y abre `http://localhost:8000`.
- GitHub pausa los workflows programados si el repositorio pasa 60 días sin actividad. Se reactiva en la pestaña Actions.

## Aviso

Son estimaciones estadísticas del modelo de la API, no garantías. Solo para mayores de 18 años.
