#!/usr/bin/env python3
"""
Consulta API-Football y genera:
  data/picks.json              -> partidos próximos con sus picks y nivel de confianza
  data/historial.json          -> picks pasados con su resultado y aciertos por nivel
  data/cache_predicciones.json -> predicciones ya pedidas (para no gastar llamadas)

Solo usa la librería estándar de Python. La clave está en CLAVE_API (más abajo);
si existe la variable de entorno API_FOOTBALL_KEY, esa tiene prioridad.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

# Clave de API-Football escrita directamente en el código (decisión del dueño del repo).
# Si algún día quieres ocultarla, deja esto vacío y usa el secreto API_FOOTBALL_KEY.
CLAVE_API = "1b1294ece02d7b5a289c9346b149c224"

RAIZ = Path(__file__).resolve().parent.parent
DATOS = RAIZ / "data"
BASE = "https://v3.football.api-sports.io"
NIVELES = ["media", "confiada", "super"]  # de menor a mayor
FINALIZADO = ("FT", "AET", "PEN")
ANULADO = ("CANC", "ABD", "AWD", "WO")
MAX_HISTORIAL = 400
RESERVA_FINAL = 3  # llamadas que se dejan sin usar por seguridad


# ----------------------------------------------------------------- utilidades
def cargar(ruta, defecto):
    try:
        return json.loads(Path(ruta).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return defecto


def guardar(ruta, obj):
    Path(ruta).write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def pct(valor):
    """'45%' -> 45.0 ; None -> 0.0"""
    try:
        return float(str(valor).replace("%", "").strip())
    except (TypeError, ValueError):
        return 0.0


def dig(d, *claves, default=None):
    for c in claves:
        if isinstance(d, dict) and c in d:
            d = d[c]
        else:
            return default
    return default if d is None else d


def parse_fecha(texto):
    return datetime.fromisoformat(texto)


# ------------------------------------------------------------------- cliente
class SinPresupuesto(Exception):
    pass


class Api:
    def __init__(self, clave, max_llamadas, pausa):
        self.clave = clave
        self.max_llamadas = max_llamadas
        self.pausa = pausa
        self.llamadas = 0
        self.avisos = []

    def restantes(self):
        return self.max_llamadas - self.llamadas

    def get(self, ruta, **params):
        if self.llamadas >= self.max_llamadas:
            raise SinPresupuesto()
        if self.llamadas > 0:
            time.sleep(self.pausa)  # el plan gratis limita llamadas por minuto
        url = f"{BASE}{ruta}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"x-apisports-key": self.clave})
        self.llamadas += 1
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                cuerpo = json.loads(r.read().decode("utf-8"))
                restante_dia = r.headers.get("x-ratelimit-requests-remaining")
        except urllib.error.HTTPError as e:
            print(f"  ! HTTP {e.code} en {ruta} {params}")
            if e.code == 429:
                self.max_llamadas = self.llamadas  # parar todo
            return None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            print(f"  ! Error de red en {ruta}: {e}")
            return None

        if restante_dia is not None:
            try:
                if int(restante_dia) <= RESERVA_FINAL:
                    print("  ! Cupo diario casi agotado, se detienen las llamadas.")
                    self.max_llamadas = self.llamadas
            except ValueError:
                pass

        errores = cuerpo.get("errors")
        if errores:  # la API devuelve [] si todo va bien, o un dict/lista con errores
            texto = json.dumps(errores, ensure_ascii=False)
            print(f"  ! La API respondió con errores en {ruta}: {texto}")
            self.avisos.append(f"{ruta}: {texto}")
            if "rate" in texto.lower() or "request" in texto.lower():
                self.max_llamadas = self.llamadas
            return None
        return cuerpo.get("response", [])


# ------------------------------------------------------------------- lógica
def temporada(liga, ahora):
    if liga.get("temporada"):
        return liga["temporada"]
    if liga.get("tipo_temporada") == "europea":
        return ahora.year if ahora.month >= 7 else ahora.year - 1
    return ahora.year


def compactar_prediccion(p):
    pred = p.get("predictions") or {}
    comp = p.get("comparison") or {}

    def par(clave):
        return {
            "home": pct(dig(comp, clave, "home")),
            "away": pct(dig(comp, clave, "away")),
        }

    h2h = []
    for f in (p.get("h2h") or [])[:5]:
        h2h.append({
            "fecha": dig(f, "fixture", "date"),
            "local": dig(f, "teams", "home", "name"),
            "visita": dig(f, "teams", "away", "name"),
            "gl": dig(f, "goals", "home"),
            "gv": dig(f, "goals", "away"),
        })

    return {
        "percent": {k: pct(dig(pred, "percent", k)) for k in ("home", "draw", "away")},
        "consejo": pred.get("advice"),
        "under_over": pred.get("under_over"),
        "goles": pred.get("goals"),
        "forma": par("form"),
        "ataque": par("att"),
        "defensa": par("def"),
        "h2h_pct": par("h2h"),
        "ultimos5": {
            "home": pct(dig(p, "teams", "home", "last_5", "form")),
            "away": pct(dig(p, "teams", "away", "last_5", "form")),
        },
        "h2h": h2h,
    }


def nivel_por_prob(prob, umbrales):
    for nombre in ("super", "confiada", "media"):
        if prob >= umbrales[nombre]:
            return nombre
    return None


def bajar_nivel(nivel):
    i = NIVELES.index(nivel) - 1
    return NIVELES[i] if i >= 0 else None


def generar_picks(partido, pred, umbrales):
    pc = pred["percent"]
    ph, pe, pa = pc["home"], pc["draw"], pc["away"]
    if ph + pe + pa <= 0:
        return []

    favorito = "home" if ph >= pa else "away"
    nombre = partido["local" if favorito == "home" else "visitante"]["nombre"]
    p_gana = ph if favorito == "home" else pa

    candidatos = [
        {"mercado": "1x2", "lado": favorito, "prob": p_gana, "texto": f"Gana {nombre}"},
        {"mercado": "doble", "lado": favorito, "prob": min(p_gana + pe, 100.0),
         "texto": f"{nombre} gana o empata"},
    ]

    picks = []
    for c in candidatos:
        nivel = nivel_por_prob(c["prob"], umbrales[c["mercado"]])
        if not nivel:
            continue
        ajuste = None
        forma = pred["forma"][c["lado"]]
        if 0 < forma < 40:  # la forma reciente relativa contradice al modelo
            nuevo = bajar_nivel(nivel)
            ajuste = "Bajó un nivel: su forma reciente es peor que la del rival."
            nivel = nuevo
        if not nivel:
            continue
        c["nivel"] = nivel
        c["prob"] = round(c["prob"])
        if ajuste:
            c["ajuste"] = ajuste
        picks.append(c)

    picks.sort(key=lambda c: (NIVELES.index(c["nivel"]), c["prob"]), reverse=True)
    return picks


def evaluar_pick(pick, gl, gv):
    if pick["mercado"] == "1x2":
        return gl > gv if pick["lado"] == "home" else gv > gl
    return gl >= gv if pick["lado"] == "home" else gv >= gl


def resolver_historial(api, hist, ahora):
    pendientes = [
        e for e in hist["partidos"]
        if e.get("estado") == "pendiente" and parse_fecha(e["fecha"]) < ahora - timedelta(hours=3)
    ]
    if not pendientes:
        return
    print(f"Resolviendo {len(pendientes)} partidos pendientes del historial...")
    por_id = {e["id"]: e for e in pendientes}
    ids = list(por_id)
    for i in range(0, len(ids), 20):
        lote = ids[i:i + 20]
        resp = api.get("/fixtures", ids="-".join(str(x) for x in lote))
        if resp is None:
            continue
        for f in resp:
            e = por_id.get(dig(f, "fixture", "id"))
            if not e:
                continue
            corto = dig(f, "fixture", "status", "short", default="")
            if corto in FINALIZADO:
                gl = dig(f, "score", "fulltime", "home")
                gv = dig(f, "score", "fulltime", "away")
                if gl is None or gv is None:
                    gl, gv = dig(f, "goals", "home"), dig(f, "goals", "away")
                if gl is None or gv is None:
                    continue
                e["marcador"] = f"{gl}-{gv}"
                for p in e["picks"]:
                    p["acierto"] = bool(evaluar_pick(p, gl, gv))
                e["estado"] = "resuelto"
            elif corto in ANULADO:
                e["estado"] = "anulado"
    # Lo que lleva más de 10 días sin resolverse se descarta de las cuentas
    for e in pendientes:
        if e["estado"] == "pendiente" and parse_fecha(e["fecha"]) < ahora - timedelta(days=10):
            e["estado"] = "sin_dato"


def calcular_resumen(hist):
    res = {"por_nivel": {n: {"total": 0, "aciertos": 0} for n in NIVELES},
           "por_mercado": {"1x2": {"total": 0, "aciertos": 0},
                           "doble": {"total": 0, "aciertos": 0}}}
    for e in hist["partidos"]:
        if e.get("estado") != "resuelto":
            continue
        for p in e["picks"]:
            if "acierto" not in p:
                continue
            for grupo, clave in (("por_nivel", p["nivel"]), ("por_mercado", p["mercado"])):
                res[grupo][clave]["total"] += 1
                res[grupo][clave]["aciertos"] += 1 if p["acierto"] else 0
    return res


# -------------------------------------------------------------------- main
def main():
    clave = (os.environ.get("API_FOOTBALL_KEY") or CLAVE_API).strip()
    if not clave:
        print("Falta la clave: escríbela en CLAVE_API o define API_FOOTBALL_KEY.")
        return 1

    cfg = cargar(RAIZ / "config.json", None)
    if not cfg:
        print("No se pudo leer config.json")
        return 1

    zona = ZoneInfo(cfg["zona_horaria"])
    ahora = datetime.now(timezone.utc)
    hoy_local = ahora.astimezone(zona).date()
    desde = hoy_local.isoformat()
    hasta = (hoy_local + timedelta(days=cfg["dias_adelante"])).isoformat()

    api = Api(clave, cfg["max_llamadas"], cfg["pausa_segundos"])
    cache = cargar(DATOS / "cache_predicciones.json", {})
    hist = cargar(DATOS / "historial.json", {"partidos": [], "resumen": {}})

    # 1) Resultados de picks anteriores
    try:
        resolver_historial(api, hist, ahora)
    except SinPresupuesto:
        pass

    # 2) Calendario de las ligas configuradas
    partidos = {}
    try:
        for liga in cfg["ligas"]:
            temp = temporada(liga, ahora)
            print(f"Calendario {liga['nombre']} (temporada {temp})...")
            resp = api.get("/fixtures", league=liga["id"], season=temp,
                           timezone=cfg["zona_horaria"], **{"from": desde, "to": hasta})
            for f in resp or []:
                if dig(f, "fixture", "status", "short") != "NS":
                    continue
                fid = dig(f, "fixture", "id")
                partidos[fid] = {
                    "id": fid,
                    "fecha": dig(f, "fixture", "date"),
                    "estadio": dig(f, "fixture", "venue", "name"),
                    "liga": {"id": liga["id"], "nombre": liga["nombre"],
                             "pais": liga["pais"], "logo": dig(f, "league", "logo")},
                    "local": {"id": dig(f, "teams", "home", "id"),
                              "nombre": dig(f, "teams", "home", "name"),
                              "logo": dig(f, "teams", "home", "logo")},
                    "visitante": {"id": dig(f, "teams", "away", "id"),
                                  "nombre": dig(f, "teams", "away", "name"),
                                  "logo": dig(f, "teams", "away", "logo")},
                }
    except SinPresupuesto:
        pass
    print(f"Partidos próximos encontrados: {len(partidos)}")

    # 3) Predicciones: primero los que no tienen caché, luego los más viejos
    limite_viejo = ahora - timedelta(hours=20)

    def es_viejo(fid):
        item = cache.get(str(fid))
        return item is None or parse_fecha(item["obtenido"]) < limite_viejo

    cola = sorted((p for p in partidos.values() if es_viejo(p["id"])),
                  key=lambda p: (str(p["id"]) in cache, p["fecha"]))
    try:
        for p in cola:
            if api.restantes() <= RESERVA_FINAL:
                break
            print(f"Predicción {p['local']['nombre']} vs {p['visitante']['nombre']}...")
            resp = api.get("/predictions", fixture=p["id"])
            if resp:
                cache[str(p["id"])] = {"obtenido": ahora.isoformat(),
                                       "pred": compactar_prediccion(resp[0])}
            elif resp == []:
                cache[str(p["id"])] = {"obtenido": ahora.isoformat(), "pred": None}
    except SinPresupuesto:
        pass

    # 4) Armar picks.json
    salida = []
    for p in sorted(partidos.values(), key=lambda x: x["fecha"]):
        item = cache.get(str(p["id"]))
        if not item or not item.get("pred"):
            continue
        picks = generar_picks(p, item["pred"], cfg["umbrales"])
        nivel_max = picks[0]["nivel"] if picks else None
        salida.append({**p, "picks": picks, "nivel_max": nivel_max,
                       "analisis": item["pred"]})

    # 5) Registrar en el historial los picks que aún no se juegan
    por_id = {e["id"]: e for e in hist["partidos"]}
    for s in salida:
        if not s["picks"] or parse_fecha(s["fecha"]) <= ahora:
            continue
        guardados = [{k: v for k, v in pk.items() if k != "ajuste"} for pk in s["picks"]]
        e = por_id.get(s["id"])
        if e and e.get("estado") == "pendiente":
            e["picks"] = guardados
            e["fecha"] = s["fecha"]
        elif not e:
            hist["partidos"].append({
                "id": s["id"], "fecha": s["fecha"], "liga": s["liga"]["nombre"],
                "local": s["local"]["nombre"], "visitante": s["visitante"]["nombre"],
                "picks": guardados, "estado": "pendiente"})
    hist["partidos"].sort(key=lambda e: e["fecha"])
    hist["partidos"] = hist["partidos"][-MAX_HISTORIAL:]
    hist["resumen"] = calcular_resumen(hist)

    # 6) Limpiar caché viejo y guardar todo
    activos = {str(i) for i in partidos}
    limite_borrar = ahora - timedelta(days=7)
    cache = {k: v for k, v in cache.items()
             if k in activos or parse_fecha(v["obtenido"]) >= limite_borrar}

    DATOS.mkdir(exist_ok=True)
    guardar(DATOS / "cache_predicciones.json", cache)
    guardar(DATOS / "historial.json", hist)
    guardar(DATOS / "picks.json", {
        "generado": ahora.isoformat(),
        "llamadas_usadas": api.llamadas,
        "avisos": api.avisos[:5],
        "partidos": salida,
    })
    con_pick = sum(1 for s in salida if s["picks"])
    print(f"Listo. {len(salida)} partidos analizados, {con_pick} con pick. "
          f"Llamadas usadas: {api.llamadas}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
