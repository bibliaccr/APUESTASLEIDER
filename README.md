# Picks de fútbol

Web estática en GitHub Pages. Un workflow de GitHub Actions corre dos veces al día,
consulta [football-data.org](https://www.football-data.org/documentation/quickstart),
calcula las probabilidades y guarda el resultado en `data/*.json`. La web solo lee esos archivos.

## Cómo se calculan los picks

1. Por cada liga se descarga la temporada completa (1 llamada por liga).
2. Con los partidos terminados se mide el ataque y la defensa de cada equipo
   (goles a favor y en contra, suavizados hacia el promedio de la liga).
3. Una distribución de Poisson convierte eso en probabilidades: gana local, empate,
   gana visitante, más de 1.5 goles, menos de 3.5 goles, etc.
4. Cada apuesta recibe un nivel según su probabilidad. La regla es la misma para todas
   las apuestas, así que el nivel siempre coincide con el porcentaje que ves:

| Nivel | Probabilidad |
|---|---|
| Súper confiada | 85 % o más |
| Confiada | 75 % o más |
| Medianamente confiada | 65 % o más |

Si la forma reciente del equipo elegido es peor que la del rival, o hay menos de 8 partidos
jugados esta temporada, se restan 5 puntos al porcentaje por cada alerta (y se avisa en el pick).
Los umbrales (`niveles`) y la resta (`penalizacion`) están en `config.json`.

La pestaña **Historial de aciertos** guarda cada pick, revisa el resultado cuando termina
el partido y muestra cuántos aciertos tuvo cada nivel. Esa es la forma de comprobar si
los umbrales sirven: con el tiempo, "Súper confiada" debería acertar más que las otras.

## Ligas disponibles

El plan gratis de football-data.org cubre: Premier League (PL), LaLiga (PD), Serie A (SA),
Bundesliga (BL1), Ligue 1 (FL1), Champions League (CL), Primeira Liga (PPL), Eredivisie (DED),
Brasileirão (BSA), Championship (ELC), Eurocopa (EC) y Mundial (WC).
**No cubre Liga BetPlay ni Copa Libertadores.**
Para añadir o quitar ligas, edita la lista `ligas` en `config.json`.

## Límites

- Plan gratis: 10 llamadas por minuto. El script espera 7 segundos entre llamadas y
  además lee las cabeceras de la API para frenarse si hace falta.
- Una ejecución usa unas 10 llamadas de ligas más hasta 6 de enfrentamientos directos
  (se guardan en `data/cache_predicciones.json` y no se repiten). Dura unos 2 minutos.

## Actualizar el repositorio con esta versión

Copia el contenido de la carpeta sobre tu repo (reemplazando archivos), y en GitHub Desktop
haz **Commit to main** y **Push origin**. Luego corre a mano **Actions > Actualizar picks > Run workflow**.

## Si algo falla

- **Aviso de la API en la web, con HTTP 403:** esa liga no está incluida en tu plan.
  Quítala de `config.json`.
- **"Pocos partidos jugados, se omite" en el log:** la liga acaba de empezar.
- **La web dice "Aún sin datos":** el workflow no ha corrido o terminó con error; mira los logs en Actions.
- **Cambios que no se ven:** espera 1 o 2 minutos a que Pages republique y recarga con Ctrl+F5.
- **Probar en tu computador:** `python3 -m http.server` en la carpeta y abre `http://localhost:8000`.
- GitHub pausa los workflows programados tras 60 días sin actividad en el repo.

## Aviso

Son estimaciones estadísticas, no garantías. Solo para mayores de 18 años.

## Apuestas por partido

- La galería muestra solo los partidos. Al tocar uno se ven sus apuestas destacadas (hasta 4;
  si las apuestas de goles o "ambos marcan" alcanzan un nivel, se les asegura lugar).
- El botón **Apuestas** abre la lista completa en dos secciones: *Tiempo completo* y *Medio tiempo*.
  El medio tiempo usa los goles al descanso de cada equipo (mismo método Poisson).
  En la lista completa se muestran las apuestas de 50 % o más; entre 50 y 64 % salen como "Baja confianza".
- El botón **Estadísticas** muestra los datos del partido y los últimos cruces.
- Solo hay un partido abierto a la vez; tocar cualquier cosa fuera de él lo cierra.
- El título de la página se cambia en `index.html` (dos lugares: `<title>` y `<h1>`).
