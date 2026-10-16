#!/usr/bin/env python3
"""
Genera los datos de la web a partir de football-data.org (v4):
  data/picks.json              -> próximos partidos con picks y nivel de confianza
  data/historial.json          -> picks pasados con resultado y aciertos por nivel
  data/cache_predicciones.json -> enfrentamientos directos ya consultados

Cómo funciona: por cada liga se baja la temporada completa (1 llamada). Con los
partidos terminados se calcula la fuerza de ataque y defensa de cada equipo y,
con una distribución de Poisson, la probabilidad de cada resultado.

Solo usa la librería estándar de Python.
"""
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Token de football-data.org escrito en el código (decisión del dueño del repo).
# Si defines la variable de entorno FOOTBALL_DATA_TOKEN, esa tiene prioridad.
TOKEN = "c29619eb39ea470c9a2d4771406418e5"

RAIZ = Path(__file__).resolve().parent.parent
DATOS = RAIZ / "data"
BASE = "https://api.football-data.org/v4"
NIVELES = ["media", "confiada", "super"]  # de menor a mayor
POR_EQUIPO_MAX_PICKS = 3
MAX_HISTORIAL = 400


# ----------------------------------------------------------------- utilidades
def cargar(ruta, defecto):
    try:
        return json.loads(Path(ruta).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return defecto


def guardar(ruta, obj):
    Path(ruta).write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def dig(d, *claves, default=None):
    for c in claves:
        if isinstance(d, dict) and c in d:
            d = d[c]
        else:
            return default
    return default if d is None else d


def parse_fecha(texto):
    return datetime.fromisoformat(texto.replace("Z", "+00:00"))


def nombre_equipo(t):
    return (t or {}).get("shortName") or (t or {}).get("name") or "?"


# ------------------------------------------------------------------- cliente
class SinPresupuesto(Exception):
    pass


class Api:
    def __init__(self, token, max_llamadas, pausa):
        self.token = token
        self.max_llamadas = max_llamadas
        self.pausa = pausa
        self.llamadas = 0
        self.avisos = []
        self.prohibidos = set()

    def get(self, ruta, **params):
        """Devuelve el JSON o None si hubo error. Respeta el límite por minuto."""
        for intento in (1, 2):
            if self.llamadas >= self.max_llamadas:
                raise SinPresupuesto()
            if self.llamadas > 0:
                time.sleep(self.pausa)
            url = f"{BASE}{ruta}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
            req = urllib.request.Request(url, headers={"X-Auth-Token": self.token})
            self.llamadas += 1
            try:
                with urllib.request.urlopen(req, timeout=40) as r:
                    cuerpo = json.loads(r.read().decode("utf-8"))
                    self._respetar_limite(r.headers)
                    return cuerpo
            except urllib.error.HTTPError as e:
                try:
                    msg = json.loads(e.read().decode("utf-8")).get("message", "")
                except Exception:
                    msg = ""
                if e.code == 429 and intento == 1:
                    espera = self._segundos_reset(e.headers) or 60
                    print(f"  ! Límite por minuto alcanzado; espero {espera}s y reintento.")
                    time.sleep(min(espera + 1, 70))
                    continue
                print(f"  ! HTTP {e.code} en {ruta}: {msg}")
                self.avisos.append(f"{ruta} -> HTTP {e.code}: {msg}")
                if e.code == 403:
                    self.prohibidos.add(ruta)
                return None
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
                print(f"  ! Error de red en {ruta}: {e}")
                return None
        return None

    @staticmethod
    def _segundos_reset(headers):
        try:
            return int(headers.get("X-RequestCounter-Reset"))
        except (TypeError, ValueError):
            return None

    def _respetar_limite(self, headers):
        try:
            disponibles = int(headers.get("X-Requests-Available-Minute"))
        except (TypeError, ValueError):
            return
        if disponibles <= 1:
            espera = self._segundos_reset(headers) or 60
            print(f"  (cupo por minuto casi agotado, espero {espera}s)")
            time.sleep(min(espera + 1, 70))


# ----------------------------------------------------------- modelo estadístico
def goles(partido):
    """Goles en tiempo reglamentario (gl, gv) o None."""
    sc = partido.get("score") or {}
    reg = sc.get("regularTime") or {}
    ft = sc.get("fullTime") or {}
    gl = reg.get("home") if reg.get("home") is not None else ft.get("home")
    gv = reg.get("away") if reg.get("away") is not None else ft.get("away")
    if gl is None or gv is None:
        return None
    return int(gl), int(gv)


def construir_modelo(partidos):
    """Promedios de la liga y estadísticas por equipo con los partidos terminados."""
    equipos = {}
    tot_l = tot_v = n = 0
    terminados = [p for p in partidos if p.get("status") == "FINISHED" and goles(p)]
    terminados.sort(key=lambda p: p["utcDate"])
    for p in terminados:
        gl, gv = goles(p)
        tot_l += gl
        tot_v += gv
        n += 1
        for lado, gf, gc in (("homeTeam", gl, gv), ("awayTeam", gv, gl)):
            tid = dig(p, lado, "id")
            e = equipos.setdefault(tid, {"gf": 0, "gc": 0, "n": 0, "pts": []})
            e["gf"] += gf
            e["gc"] += gc
            e["n"] += 1
            e["pts"].append(3 if gf > gc else 1 if gf == gc else 0)
    if n < 10:
        return None
    return {"H": tot_l / n, "A": tot_v / n, "equipos": equipos}


def pmf(k, lam):
    return math.exp(-lam) * lam ** k / math.factorial(k)


def predecir(modelo, id_local, id_vis, k):
    el, ev = modelo["equipos"].get(id_local), modelo["equipos"].get(id_vis)
    if not el or not ev:
        return None
    H, A = modelo["H"], modelo["A"]
    prom = (H + A) / 2

    def fuerza(e):  # ataque y defensa relativos al promedio, con suavizado
        att = ((e["gf"] + k * prom) / (e["n"] + k)) / prom
        dfn = ((e["gc"] + k * prom) / (e["n"] + k)) / prom
        return att, dfn

    att_l, def_l = fuerza(el)
    att_v, def_v = fuerza(ev)
    lam = min(max(H * att_l * def_v, 0.2), 4.5)   # goles esperados del local
    mu = min(max(A * att_v * def_l, 0.2), 4.5)    # goles esperados del visitante

    N = 11
    pl = [pmf(i, lam) for i in range(N)]
    pv = [pmf(j, mu) for j in range(N)]
    p_loc = p_emp = p_vis = p_tot_le1 = p_tot_le3 = 0.0
    p_tot_le2 = 0.0
    for i in range(N):
        for j in range(N):
            p = pl[i] * pv[j]
            if i > j:
                p_loc += p
            elif i == j:
                p_emp += p
            else:
                p_vis += p
            if i + j <= 1:
                p_tot_le1 += p
            if i + j <= 2:
                p_tot_le2 += p
            if i + j <= 3:
                p_tot_le3 += p
    total = p_loc + p_emp + p_vis
    p_loc, p_emp, p_vis = (x / total * 100 for x in (p_loc, p_emp, p_vis))
    mas15 = (1 - p_tot_le1 / total) * 100
    menos35 = p_tot_le3 / total * 100
    mas25 = (1 - p_tot_le2 / total) * 100
    ambos = (1 - math.exp(-lam)) * (1 - math.exp(-mu)) * 100

    def forma5(e):
        ult = e["pts"][-5:]
        return sum(ult) / (3 * len(ult)) * 100 if ult else 0.0

    f_l, f_v = forma5(el), forma5(ev)
    suma = f_l + f_v
    relativa = (f_l / suma * 100, f_v / suma * 100) if suma > 0 else (50.0, 50.0)

    return {
        "percent": {"home": round(p_loc, 1), "draw": round(p_emp, 1), "away": round(p_vis, 1)},
        "mas15": round(mas15, 1), "menos35": round(menos35, 1),
        "mas25": round(mas25, 1), "ambos": round(ambos, 1),
        "goles_esp": {"home": round(lam, 2), "away": round(mu, 2)},
        "ultimos5": {"home": round(f_l), "away": round(f_v)},
        "forma": {"home": round(relativa[0]), "away": round(relativa[1])},
        "gf": {"home": round(el["gf"] / el["n"], 2), "away": round(ev["gf"] / ev["n"], 2)},
        "gc": {"home": round(el["gc"] / el["n"], 2), "away": round(ev["gc"] / ev["n"], 2)},
        "jugados": {"home": el["n"], "away": ev["n"]},
    }


# ------------------------------------------------------------------- picks
def nivel_por_prob(prob, umbrales):
    for nombre in ("super", "confiada", "media"):
        if prob >= umbrales[nombre]:
            return nombre
    return None


def bajar_nivel(nivel):
    i = NIVELES.index(nivel) - 1
    return NIVELES[i] if i >= 0 else None


def generar_picks(partido, pred, cfg):
    um = cfg["umbrales"]
    pc = pred["percent"]
    ph, pe, pa = pc["home"], pc["draw"], pc["away"]
    favorito = "home" if ph >= pa else "away"
    nombre = partido["local" if favorito == "home" else "visitante"]["nombre"]
    p_gana = ph if favorito == "home" else pa

    candidatos = [
        {"mercado": "1x2", "lado": favorito, "prob": p_gana, "texto": f"Gana {nombre}"},
        {"mercado": "doble", "lado": favorito, "prob": min(p_gana + pe, 100.0),
         "texto": f"{nombre} gana o empata"},
        {"mercado": "mas15", "lado": None, "prob": pred["mas15"], "texto": "Más de 1.5 goles"},
        {"mercado": "menos35", "lado": None, "prob": pred["menos35"], "texto": "Menos de 3.5 goles"},
    ]
    pocos = min(pred["jugados"]["home"], pred["jugados"]["away"]) < cfg["partidos_confiables"]

    picks = []
    for c in candidatos:
        nivel = nivel_por_prob(c["prob"], um[c["mercado"]])
        if not nivel:
            continue
        ajustes = []
        if c["lado"] and 0 < pred["forma"][c["lado"]] < 40:
            nivel = bajar_nivel(nivel)
            ajustes.append("su forma reciente es peor que la del rival")
        if nivel and pocos:
            nivel = bajar_nivel(nivel)
            ajustes.append("hay pocos partidos jugados esta temporada")
        if not nivel:
            continue
        c["nivel"] = nivel
        c["prob"] = round(c["prob"])
        if ajustes:
            c["ajuste"] = "Bajó de nivel: " + " y ".join(ajustes) + "."
        picks.append(c)

    picks.sort(key=lambda c: (NIVELES.index(c["nivel"]), c["prob"]), reverse=True)
    return picks[:POR_EQUIPO_MAX_PICKS]


def evaluar_pick(pick, gl, gv):
    m = pick["mercado"]
    if m == "1x2":
        return gl > gv if pick["lado"] == "home" else gv > gl
    if m == "doble":
        return gl >= gv if pick["lado"] == "home" else gv >= gl
    if m == "mas15":
        return gl + gv >= 2
    if m == "menos35":
        return gl + gv <= 3
    return False


def resolver_historial(hist, por_id, ahora):
    for e in hist["partidos"]:
        if e.get("estado") != "pendiente":
            continue
        p = por_id.get(e["id"])
        if p:
            estado = p.get("status")
            g = goles(p)
            if estado == "FINISHED" and g:
                e["marcador"] = f"{g[0]}-{g[1]}"
                for pk in e["picks"]:
                    pk["acierto"] = bool(evaluar_pick(pk, *g))
                e["estado"] = "resuelto"
                continue
            if estado == "CANCELLED":
                e["estado"] = "anulado"
                continue
        if parse_fecha(e["fecha"]) < ahora - timedelta(days=10):
            e["estado"] = "sin_dato"


def calcular_resumen(hist):
    res = {"por_nivel": {n: {"total": 0, "aciertos": 0} for n in NIVELES}, "por_mercado": {}}
    for e in hist["partidos"]:
        if e.get("estado") != "resuelto":
            continue
        for p in e["picks"]:
            if "acierto" not in p:
                continue
            m = res["por_mercado"].setdefault(p["mercado"], {"total": 0, "aciertos": 0})
            for r in (res["por_nivel"][p["nivel"]], m):
                r["total"] += 1
                r["aciertos"] += 1 if p["acierto"] else 0
    return res


# -------------------------------------------------------------------- main
def main():
    token = (os.environ.get("FOOTBALL_DATA_TOKEN") or TOKEN).strip()
    if not token:
        print("Falta el token: escríbelo en TOKEN o define FOOTBALL_DATA_TOKEN.")
        return 1
    cfg = cargar(RAIZ / "config.json", None)
    if not cfg:
        print("No se pudo leer config.json")
        return 1

    ahora = datetime.now(timezone.utc)
    limite = ahora + timedelta(days=cfg["dias_adelante"])
    api = Api(token, cfg["max_llamadas"], cfg["pausa_segundos"])
    cache = cargar(DATOS / "cache_predicciones.json", {})
    hist = cargar(DATOS / "historial.json", {"partidos": [], "resumen": {}})

    # 1) Una llamada por liga: toda la temporada
    ligas_datos = []  # (liga, partidos)
    por_id = {}
    try:
        for liga in cfg["ligas"]:
            print(f"Descargando {liga['nombre']} ({liga['codigo']})...")
            r = api.get(f"/competitions/{liga['codigo']}/matches")
            if not r:
                continue
            partidos = r.get("matches") or []
            emblema = dig(r, "competition", "emblem")
            ligas_datos.append((liga, partidos, emblema))
            for p in partidos:
                por_id[p["id"]] = p
            print(f"  {len(partidos)} partidos en la temporada")
    except SinPresupuesto:
        pass

    # 2) Resolver aciertos del historial con los datos recién bajados
    resolver_historial(hist, por_id, ahora)

    # 3) Probabilidades de los partidos de los próximos días
    salida = []
    for liga, partidos, emblema in ligas_datos:
        modelo = construir_modelo(partidos)
        if not modelo:
            print(f"  {liga['nombre']}: pocos partidos jugados, se omite.")
            continue
        for p in partidos:
            if p.get("status") not in ("SCHEDULED", "TIMED"):
                continue
            fecha = parse_fecha(p["utcDate"])
            if not (ahora < fecha <= limite):
                continue
            idl, idv = dig(p, "homeTeam", "id"), dig(p, "awayTeam", "id")
            pred = predecir(modelo, idl, idv, cfg["suavizado"])
            if not pred:
                continue
            if min(pred["jugados"].values()) < cfg["min_partidos"]:
                continue
            partido = {
                "id": p["id"],
                "fecha": p["utcDate"],
                "liga": {"id": liga["codigo"], "nombre": liga["nombre"],
                         "pais": liga["pais"], "logo": emblema},
                "local": {"id": idl, "nombre": nombre_equipo(p.get("homeTeam")),
                          "logo": dig(p, "homeTeam", "crest")},
                "visitante": {"id": idv, "nombre": nombre_equipo(p.get("awayTeam")),
                              "logo": dig(p, "awayTeam", "crest")},
            }
            picks = generar_picks(partido, pred, cfg)
            partido.update({"picks": picks,
                            "nivel_max": picks[0]["nivel"] if picks else None,
                            "analisis": pred})
            salida.append(partido)
    salida.sort(key=lambda s: s["fecha"])
    print(f"Partidos analizados: {len(salida)}")

    # 4) Enfrentamientos directos para los mejores picks (con caché)
    vistos = 0
    candidatos = [s for s in salida if s["nivel_max"] in ("super", "confiada")]
    try:
        for s in candidatos:
            key = str(s["id"])
            if key in cache or vistos >= cfg["h2h_max"]:
                continue
            if any("head2head" in r for r in api.prohibidos):
                break
            print(f"Cruces {s['local']['nombre']} vs {s['visitante']['nombre']}...")
            r = api.get(f"/matches/{s['id']}/head2head", limit=5)
            vistos += 1
            if r is None:
                continue
            cache[key] = {"obtenido": ahora.isoformat(), "h2h": [
                {"fecha": m.get("utcDate"),
                 "local": nombre_equipo(m.get("homeTeam")),
                 "visita": nombre_equipo(m.get("awayTeam")),
                 "gl": dig(m, "score", "fullTime", "home"),
                 "gv": dig(m, "score", "fullTime", "away")}
                for m in (r.get("matches") or [])[:5]]}
    except SinPresupuesto:
        pass
    for s in salida:
        s["analisis"]["h2h"] = (cache.get(str(s["id"])) or {}).get("h2h", [])

    # 5) Registrar en el historial los picks que aún no se juegan
    existentes = {e["id"]: e for e in hist["partidos"]}
    for s in salida:
        if not s["picks"]:
            continue
        guardados = [{k: v for k, v in pk.items() if k != "ajuste"} for pk in s["picks"]]
        e = existentes.get(s["id"])
        if e and e.get("estado") == "pendiente":
            e["picks"], e["fecha"] = guardados, s["fecha"]
        elif not e:
            hist["partidos"].append({
                "id": s["id"], "fecha": s["fecha"], "liga": s["liga"]["nombre"],
                "local": s["local"]["nombre"], "visitante": s["visitante"]["nombre"],
                "picks": guardados, "estado": "pendiente"})
    hist["partidos"].sort(key=lambda e: e["fecha"])
    hist["partidos"] = hist["partidos"][-MAX_HISTORIAL:]
    hist["resumen"] = calcular_resumen(hist)

    # 6) Limpiar caché viejo y guardar
    activos = {str(s["id"]) for s in salida}
    cache = {k: v for k, v in cache.items()
             if k in activos or parse_fecha(v["obtenido"]) > ahora - timedelta(days=7)}
    DATOS.mkdir(exist_ok=True)
    guardar(DATOS / "cache_predicciones.json", cache)
    guardar(DATOS / "historial.json", hist)
    guardar(DATOS / "picks.json", {
        "generado": ahora.isoformat(),
        "llamadas_usadas": api.llamadas,
        "avisos": api.avisos[:5],
        "partidos": salida,
    })
    print(f"Listo. {sum(1 for s in salida if s['picks'])} partidos con pick. "
          f"Llamadas usadas: {api.llamadas}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
