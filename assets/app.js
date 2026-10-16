(() => {
  "use strict";

  const ZONA = "America/Bogota";
  const NIVELES = {
    super:    { nombre: "Súper confiada",         rango: 3 },
    confiada: { nombre: "Confiada",               rango: 2 },
    media:    { nombre: "Medianamente confiada",  rango: 1 },
  };

  const estado = { tab: "picks", nivel: "todos", liga: "todas", picks: null, historial: null, abierto: null };
  const GRANDES = [["PD", "LaLiga"], ["PL", "Premier League"], ["SA", "Serie A"], ["BL1", "Bundesliga"], ["FL1", "Ligue 1"]];
  const ordenLiga = (id) => { const i = GRANDES.findIndex(([c]) => c === id); return i < 0 ? 99 : i; };
  let UMBRALES = { super: 85, confiada: 75, media: 65 };
  const panel = document.getElementById("panel");

  // ---- utilidades -------------------------------------------------------
  // Crea elementos sin usar innerHTML (los datos vienen de una API externa).
  function h(tag, attrs, ...hijos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const hijo of hijos.flat()) {
      if (hijo === null || hijo === undefined || hijo === false) continue;
      el.append(hijo.nodeType ? hijo : document.createTextNode(String(hijo)));
    }
    return el;
  }

  const fmtDia = new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: ZONA });
  const fmtHora = new Intl.DateTimeFormat("es-CO", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: ZONA });
  const fmtCorta = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone: ZONA });
  const fmtActualizado = new Intl.DateTimeFormat("es-CO", { dateStyle: "long", timeStyle: "short", timeZone: ZONA });
  const claveDia = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: ZONA });

  const medidor = (nivel) =>
    h("span", { class: "medidor", "data-nivel": nivel, "aria-hidden": "true" }, h("i"), h("i"), h("i"));

  const imagen = (src, alt = "") =>
    src ? h("img", { src, alt, loading: "lazy", width: 28, height: 28 }) : null;

  async function cargarJSON(ruta) {
    const r = await fetch(ruta + "?t=" + Date.now());
    if (!r.ok) throw new Error(ruta + " " + r.status);
    return r.json();
  }

  // ---- pestaña: próximos partidos --------------------------------------
  function filtros(partidos) {
    const cabecera = (txt) => h("div", { class: "filtro-titulo" }, txt);

    const nivelBtn = (clave, contenido) =>
      h("button", { class: "chip", type: "button", "aria-pressed": estado.nivel === clave,
        onclick: () => { estado.nivel = clave; render(); } }, contenido);
    const seccionNivel = h("div", { class: "filtro-seccion" }, cabecera("Confianza"),
      h("div", { class: "chips chips-nivel" },
        nivelBtn("todos", h("span", { class: "chip-txt" }, "Todos los niveles")),
        Object.entries(NIVELES).map(([clave, n]) =>
          nivelBtn(clave, [medidor(clave), h("span", { class: "chip-txt" }, n.nombre)]))));

    const otras = new Map();
    for (const p of partidos) if (ordenLiga(p.liga.id) === 99) otras.set(p.liga.id, p.liga.nombre);
    const opcion = (id, nombre) => h("option", { value: id, selected: estado.liga === id }, nombre);
    const seccionLiga = h("div", { class: "filtro-seccion" }, cabecera("Liga"),
      h("select", { class: "chip selector", "aria-label": "Liga",
        onchange: (e) => { estado.liga = e.target.value; render(); } },
        opcion("todas", "Todas las ligas"),
        // Las 5 grandes siempre primero (LaLiga arriba), aunque ese día no tengan partidos
        h("optgroup", { label: "Ligas principales" }, GRANDES.map(([id, nombre]) => opcion(id, nombre))),
        otras.size
          ? h("optgroup", { label: "Otras ligas" },
              [...otras].sort((x, y) => x[1].localeCompare(y[1])).map(([id, nombre]) => opcion(id, nombre)))
          : null));

    return h("div", { class: "filtros" }, seccionNivel, seccionLiga);
  }

  // ---- apuestas de un partido ----------------------------------------------
  const NOMBRE_FILA = { ...NIVELES, baja: { nombre: "Baja confianza", rango: 0 } };
  const PISO_LISTA = 50; // en la lista completa se muestran las apuestas de 50 % o más
  const nivelDe = (prob) =>
    prob >= UMBRALES.super ? "super" : prob >= UMBRALES.confiada ? "confiada" : prob >= UMBRALES.media ? "media"
    : prob >= PISO_LISTA ? "baja" : null;

  // Fila de apuesta: es la misma para las destacadas y para la lista completa
  const filaPick = (pk) =>
    h("li", { class: "pick", "data-nivel": pk.nivel },
      medidor(pk.nivel),
      h("div", null,
        h("div", { class: "pick-texto" }, pk.texto),
        h("div", { class: "pick-nivel" }, NOMBRE_FILA[pk.nivel].nombre)),
      h("div", { class: "pick-prob" }, pk.prob, h("small", null, "%")),
      pk.ajuste ? h("p", { class: "pick-ajuste" }, pk.ajuste) : null);

  // ---- apuestas que se contradicen --------------------------------------------
  // Cada apuesta se describe con lo que exige del marcador. Dos apuestas chocan si no pueden
  // cumplirse a la vez (o solo con un marcador raro). Misma regla que scripts/actualizar.py.
  const R = (...r) => ({ res: r });                 // resultado: "1" local, "X" empate, "2" visitante
  const T = (dir, linea) => ({ tot: { dir, linea } }); // goles totales: "mas" / "menos"
  const B = (v) => ({ btts: v });                   // ambos marcan sí / no
  const M = (lado, min) => ({ team: { lado, min } }); // un equipo marca "min" goles o más

  function cumple(d, gl, gv) {
    if (d.res && !d.res.includes(gl > gv ? "1" : gl < gv ? "2" : "X")) return false;
    if (d.tot && (d.tot.dir === "mas" ? gl + gv <= d.tot.linea : gl + gv >= d.tot.linea)) return false;
    if (d.btts !== undefined && d.btts !== (gl > 0 && gv > 0)) return false;
    if (d.team && (d.team.lado === "home" ? gl : gv) < d.team.min) return false;
    return true;
  }
  function hayConflicto(a, b) {
    if (a.res && b.res) return true;                              // una sola recomendación de resultado
    if (a.tot && b.tot) return a.tot.dir !== b.tot.dir;           // "más de" con "menos de", nunca
    for (const [t, r] of [[a, b], [b, a]]) {
      if (t.team && r.res && t.team.min >= 2 && !r.res.includes(t.team.lado === "home" ? "1" : "2")) return true;
    }
    for (const [x, y] of [[a, b], [b, a]]) if (x.btts === false && y.team) return true;
    let compatibles = 0;
    for (let gl = 0; gl <= 5; gl++) for (let gv = 0; gv <= 5; gv++) if (cumple(a, gl, gv) && cumple(b, gl, gv)) compatibles++;
    return compatibles <= 1;
  }

  // Cada fila: [texto, probabilidad cruda, lado ("home"/"away") si depende de la forma de un equipo,
  //             descripción de la apuesta, true si es un resultado directo (Gana / Empate)]
  function filasTiempoCompleto(p) {
    const m = p.analisis.mercados;
    if (!m) return null;
    const L = p.local.nombre, V = p.visitante.nombre, menos = (v) => 100 - v;
    return [
      [`Gana: ${L}`, m.h, "home", R("1"), true], [`Gana: ${V}`, m.a, "away", R("2"), true], ["Empate", m.x, null, R("X"), true],
      [`${L} gana o empata`, m.dc["1x"], "home", R("1", "X")], [`${V} gana o empata`, m.dc.x2, "away", R("X", "2")], ["Cualquiera gana", m.dc["12"], null, R("1", "2")],
      ["Más de 0.5 goles", m.mas["0"], null, T("mas", 0.5)], ["Más de 1.5 goles", m.mas["1"], null, T("mas", 1.5)],
      ["Más de 2.5 goles", m.mas["2"], null, T("mas", 2.5)], ["Más de 3.5 goles", m.mas["3"], null, T("mas", 3.5)],
      ["Menos de 1.5 goles", menos(m.mas["1"]), null, T("menos", 1.5)], ["Menos de 2.5 goles", menos(m.mas["2"]), null, T("menos", 2.5)],
      ["Menos de 3.5 goles", menos(m.mas["3"]), null, T("menos", 3.5)], ["Menos de 4.5 goles", menos(m.mas["4"]), null, T("menos", 4.5)],
      ["Ambos equipos marcan", m.btts, null, B(true)], ["Ambos equipos no marcan", menos(m.btts), null, B(false)],
      [`${L} marca 1 o más goles`, m.mas_local["0"], null, M("home", 1)], [`${L} marca 2 o más goles`, m.mas_local["1"], null, M("home", 2)],
      [`${V} marca 1 o más goles`, m.mas_visita["0"], null, M("away", 1)], [`${V} marca 2 o más goles`, m.mas_visita["1"], null, M("away", 2)],
    ];
  }

  function filasMedioTiempo(p) {
    const m = p.analisis.mercados_1t;
    if (!m) return null;
    const L = p.local.nombre, V = p.visitante.nombre, menos = (v) => 100 - v;
    return [
      [`Gana: ${L}`, m.h, "home", R("1"), true], [`Gana: ${V}`, m.a, "away", R("2"), true], ["Empate", m.x, null, R("X"), true],
      [`${L} gana o empata`, m.dc["1x"], "home", R("1", "X")], [`${V} gana o empata`, m.dc.x2, "away", R("X", "2")], ["Cualquiera gana", m.dc["12"], null, R("1", "2")],
      ["Más de 0.5 goles", m.mas["0"], null, T("mas", 0.5)], ["Más de 1.5 goles", m.mas["1"], null, T("mas", 1.5)],
      ["Menos de 0.5 goles", menos(m.mas["0"]), null, T("menos", 0.5)], ["Menos de 1.5 goles", menos(m.mas["1"]), null, T("menos", 1.5)],
      ["Menos de 2.5 goles", menos(m.mas["2"]), null, T("menos", 2.5)],
      ["Ambos equipos marcan", m.btts, null, B(true)], ["Ambos equipos no marcan", menos(m.btts), null, B(false)],
      [`${L} marca 1 o más goles`, m.mas_local["0"], null, M("home", 1)], [`${V} marca 1 o más goles`, m.mas_visita["0"], null, M("away", 1)],
    ];
  }

  // Aplica las mismas alertas que el robot (puntos restados), asigna nivel con la regla común
  // y descarta las apuestas que se contradicen con otra más respaldada del mismo partido.
  function construirFilas(filas, penal, limite) {
    const pen = penal || { home: 0, away: 0, global: 0 };
    const cand = filas.map(([texto, prob, lado, d, directo]) => {
      const resta = (pen.global || 0) + (lado ? pen[lado] || 0 : 0);
      const pr = Math.round(prob - resta);
      const nivel = nivelDe(pr);
      if (!nivel) return null;
      const propio = lado ? pen[lado] || 0 : 0;
      return { texto, prob: pr, nivel, d, directo,
        ajuste: propio ? `Se restaron ${propio} puntos porque su forma reciente es peor que la del rival.` : null };
    }).filter(Boolean);

    // Una sola recomendación de resultado: "Gana" / "Empate" si alcanza un nivel; si no, la más probable.
    const resultados = cand.filter((f) => f.d.res).sort((x, y) => y.prob - x.prob);
    const mejorResultado = resultados.find((f) => f.directo && f.prob >= UMBRALES.media) || resultados[0];
    const resto = cand.filter((f) => !f.d.res).concat(mejorResultado ? [mejorResultado] : []).sort((x, y) => y.prob - x.prob);

    const aceptadas = [];
    for (const f of resto) if (!aceptadas.some((o) => hayConflicto(f.d, o.d))) aceptadas.push(f);
    return aceptadas.sort((x, y) => y.prob - x.prob).slice(0, limite);
  }

  function fijarAbierto(id) {
    estado.abierto = id;
    document.querySelectorAll(".partido").forEach((t) => {
      const on = id !== null && String(id) === t.dataset.id;
      t.classList.toggle("abierta", on);
      t.querySelector(".cabeza").setAttribute("aria-expanded", on);
      t.querySelector(".detalle").hidden = !on;
      if (!on && t._reiniciar) t._reiniciar();
    });
  }

  function svgIcono(rects) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "18"); svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true");
    for (const [x, y, w, alto] of rects) {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", x); r.setAttribute("y", y); r.setAttribute("width", w); r.setAttribute("height", alto);
      r.setAttribute("rx", "1.2"); r.setAttribute("fill", "currentColor"); svg.append(r);
    }
    return svg;
  }
  // Estadísticas: tres barras, la del medio más alta. Apuestas: lista.
  const iconoStats = () => svgIcono([[3, 12, 4, 9], [10, 4, 4, 17], [17, 8, 4, 13]]);
  const iconoApuestas = () => svgIcono([[3, 4, 18, 3.5], [3, 10.25, 18, 3.5], [3, 16.5, 12, 3.5]]);

  function tarjetaPartido(p) {
    const a = p.analisis;
    const filaDato = (izq, etq, der) => [h("div", null, izq), h("div", { class: "etq" }, etq), h("div", { class: "der" }, der)];
    const pc = (v) => (v || v === 0 ? Math.round(v) + "%" : "–");
    const dec = (v) => (v || v === 0 ? Number(v).toFixed(2) : "–");

    // Último cruce: ganador en verde y negrilla, perdedor en rojo; empate sin color.
    const cruce = (x) => {
      const hayMarcador = x.gl !== null && x.gl !== undefined && x.gv !== null && x.gv !== undefined;
      const res = !hayMarcador || x.gl === x.gv ? "" : x.gl > x.gv ? "local" : "visita";
      const fila = (nombre, goles, lado) =>
        h("div", { class: "cruce-fila" + (res ? (res === lado ? " gana" : " pierde") : "") },
          h("span", { class: "cruce-eq" }, nombre), h("span", { class: "cruce-g" }, goles ?? "-"));
      return h("div", { class: "cruce" },
        h("div", { class: "cruce-fecha" }, fmtCorta.format(new Date(x.fecha))),
        fila(x.local, x.gl, "local"), fila(x.visita, x.gv, "visita"));
    };

    // 1) Apuestas destacadas (las de mejor respaldo)
    const destacadas = h("div", { class: "destacadas" },
      p.picks.length
        ? [h("div", { class: "recomendado" }, "Recomendado"), h("ul", { class: "picks" }, p.picks.map(filaPick))]
        : h("p", { class: "sin-pick" }, "Sin apuesta destacada: ninguna llega al mínimo de confianza."));

    // 2) Lista completa: tiempo completo y medio tiempo (incluye las destacadas)
    const seccion = (titulo, filas, vacio) =>
      h("section", { class: "bloque" },
        h("h3", { class: "extra-titulo" }, titulo),
        filas && filas.length ? h("ul", { class: "picks" }, filas.map(filaPick)) : h("p", { class: "sin-pick" }, vacio));
    const completo = filasTiempoCompleto(p);
    const medio = filasMedioTiempo(p);
    const avisoPocos = a.penal && a.penal.global
      ? h("p", { class: "nota-lista" }, `Hay pocos partidos jugados esta temporada: a todos los porcentajes se les restaron ${a.penal.global} puntos.`)
      : null;
    const todas = h("div", { class: "todas", hidden: true },
      completo
        ? [avisoPocos,
           seccion("Tiempo completo", completo && construirFilas(completo, a.penal, 12), "No hay apuestas con probabilidad suficiente."),
           seccion("Medio tiempo", medio && construirFilas(medio, a.penal, 8),
             medio ? "No hay apuestas con probabilidad suficiente." : "Sin datos de primer tiempo todavía.")]
        : h("p", { class: "sin-pick" }, "Las apuestas completas aparecerán tras la próxima actualización automática."));

    // 3) Estadísticas
    const stats = h("div", { class: "stats", hidden: true },
      h("div", { class: "datos" },
        filaDato(pc(a.percent.home), "Gana local / visitante", pc(a.percent.away)),
        filaDato("", "Empate " + pc(a.percent.draw), ""),
        filaDato(dec(a.goles_esp.home), "Goles esperados", dec(a.goles_esp.away)),
        filaDato(pc(a.ultimos5.home), "Puntos en los últimos 5", pc(a.ultimos5.away)),
        filaDato(dec(a.gf.home), "Goles a favor por partido", dec(a.gf.away)),
        filaDato(dec(a.gc.home), "Goles en contra por partido", dec(a.gc.away)),
        filaDato(a.jugados.home, "Partidos jugados", a.jugados.away)),
      a.h2h && a.h2h.length
        ? [h("p", { class: "consejo" }, h("strong", null, "Últimos cruces")),
           h("div", { class: "cruces" }, a.h2h.map(cruce))]
        : null);

    const btnStats = h("button", { class: "btn-det", type: "button", "aria-pressed": false }, iconoStats(), h("span", null, "Estadísticas"));
    const btnApuestas = h("button", { class: "btn-det", type: "button", "aria-pressed": false }, iconoApuestas(), h("span", null, "Apuestas"));
    btnStats.addEventListener("click", () => {
      stats.hidden = !stats.hidden;
      btnStats.setAttribute("aria-pressed", !stats.hidden);
    });
    btnApuestas.addEventListener("click", () => {
      todas.hidden = !todas.hidden;
      destacadas.hidden = !todas.hidden;   // la lista completa incluye las destacadas
      btnApuestas.setAttribute("aria-pressed", !todas.hidden);
    });

    const abierto = estado.abierto === p.id;
    const detalle = h("div", { class: "detalle", hidden: !abierto },
      destacadas, todas, stats, h("div", { class: "botones" }, btnStats, btnApuestas));

    const cabeza = h("div", { class: "cabeza", role: "button", tabindex: "0", "aria-expanded": abierto },
      h("div", { class: "partido-cab" },
        h("span", { class: "liga" }, imagen(p.liga.logo), p.liga.nombre),
        h("span", { class: "hora" }, fmtHora.format(new Date(p.fecha)), h("span", { class: "flecha", "aria-hidden": "true" }))),
      h("div", { class: "equipos" },
        h("div", { class: "equipo" }, imagen(p.local.logo), h("span", null, p.local.nombre)),
        h("span", { class: "vs" }, "vs"),
        h("div", { class: "equipo" }, imagen(p.visitante.logo), h("span", null, p.visitante.nombre))));

    const tarjeta = h("article", { class: "partido" + (abierto ? " abierta" : ""), "data-id": p.id, "data-nivel": p.nivel_max || "ninguno" },
      cabeza, detalle);
    tarjeta._reiniciar = () => {   // al cerrar el partido, todo vuelve a su estado inicial
      stats.hidden = true; todas.hidden = true; destacadas.hidden = false;
      btnStats.setAttribute("aria-pressed", false); btnApuestas.setAttribute("aria-pressed", false);
    };

    // Solo un partido abierto a la vez: al abrir uno, se cierra el anterior.
    const alternar = () => {
      fijarAbierto(estado.abierto === p.id ? null : p.id);
      if (estado.abierto === p.id && tarjeta.getBoundingClientRect().top < 0) tarjeta.scrollIntoView({ block: "start" });
    };
    cabeza.addEventListener("click", alternar);
    cabeza.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alternar(); }
    });
    return tarjeta;
  }

  function pintarPicks() {
    const datos = estado.picks;
    const todos = datos.partidos || [];
    if (!todos.length) {
      return h("div", { class: "vacio" },
        h("strong", null, "Todavía no hay partidos analizados."),
        "Ejecuta el workflow “Actualizar picks” en la pestaña Actions de GitHub, o espera a la próxima actualización automática.");
    }

    let lista = todos.filter((p) => p.picks.length);
    if (estado.nivel !== "todos") {
      lista = lista.map((p) => ({ ...p, picks: p.picks.filter((k) => k.nivel === estado.nivel) }))
                   .filter((p) => p.picks.length)
                   .map((p) => ({ ...p, nivel_max: p.picks[0].nivel }));
    }
    if (estado.liga !== "todas") lista = lista.filter((p) => p.liga.id === estado.liga);

    const salida = [filtros(todos.filter((p) => p.picks.length))];
    if (!lista.length) {
      salida.push(h("div", { class: "vacio" },
        h("strong", null, "No hay picks con estos filtros."),
        "Prueba otro nivel o la opción “Todos los niveles”."));
      return salida;
    }

    // Agrupar por día; dentro de cada día, primero los de mayor confianza
    const rango = (p) => (p.nivel_max ? NIVELES[p.nivel_max].rango : 0);
    const dias = new Map();
    for (const p of lista) {
      const k = claveDia(p.fecha);
      if (!dias.has(k)) dias.set(k, []);
      dias.get(k).push(p);
    }
    for (const [, partidos] of dias) {
      // Primero las 5 grandes ligas (LaLiga arriba), luego mayor confianza y hora
      partidos.sort((a, b) => ordenLiga(a.liga.id) - ordenLiga(b.liga.id) || rango(b) - rango(a) || a.fecha.localeCompare(b.fecha));
      salida.push(h("h2", { class: "dia" }, fmtDia.format(new Date(partidos[0].fecha))));
      salida.push(...partidos.map(tarjetaPartido));
    }
    return salida;
  }

  // ---- pestaña: historial ----------------------------------------------
  function pintarHistorial() {
    const hist = estado.historial;
    const resueltos = (hist.partidos || []).filter((e) => e.estado === "resuelto");
    if (!resueltos.length) {
      return h("div", { class: "vacio" },
        h("strong", null, "Aún no hay resultados."),
        "Cuando terminen los partidos que ya tienen pick, aquí verás cuántos aciertos tuvo cada nivel.");
    }

    const por = (hist.resumen && hist.resumen.por_nivel) || {};
    const filas = Object.entries(NIVELES).map(([clave, n]) => {
      const r = por[clave] || { total: 0, aciertos: 0 };
      const porcentaje = r.total ? Math.round((r.aciertos / r.total) * 100) + "%" : "–";
      return h("tr", null,
        h("td", null, h("span", { class: "nivel-celda" }, medidor(clave), n.nombre)),
        h("td", { class: "num" }, r.aciertos + " de " + r.total),
        h("td", { class: "num" }, porcentaje));
    });

    const tabla = h("table", { class: "resumen" },
      h("thead", null, h("tr", null,
        h("th", null, "Nivel"), h("th", { class: "num" }, "Aciertos"), h("th", { class: "num" }, "Porcentaje"))),
      h("tbody", null, filas));

    const items = resueltos.slice().reverse().slice(0, 40).map((e) =>
      h("div", { class: "hist-item" },
        h("div", { class: "t" },
          h("span", null, `${e.local} - ${e.visitante}`),
          h("span", { class: "m" }, e.marcador)),
        h("ul", null, e.picks.map((p) =>
          h("li", null,
            h("span", { class: p.acierto ? "si" : "no" }, p.acierto ? "Acertó" : "Falló"),
            h("span", null, `${p.texto} (${p.prob}%, ${NIVELES[p.nivel].nombre.toLowerCase()})`))))));

    return [
      tabla,
      h("p", { class: "nota" }, "Con pocos partidos, estos porcentajes engañan. Un nivel solo demuestra algo cuando acumula decenas de picks. Si “Súper confiada” no acierta más que “Medianamente confiada” con el tiempo, los umbrales del archivo config.json necesitan ajuste."),
      h("h2", { class: "dia" }, "Últimos resultados"),
      items,
    ];
  }

  // ---- render -----------------------------------------------------------
  function render() {
    const esPicks = estado.tab === "picks";
    document.getElementById("tab-picks").setAttribute("aria-selected", esPicks);
    document.getElementById("tab-historial").setAttribute("aria-selected", !esPicks);
    panel.replaceChildren(...[esPicks ? pintarPicks() : pintarHistorial()].flat(Infinity));
  }

  document.getElementById("tab-picks").addEventListener("click", () => { estado.tab = "picks"; render(); });
  document.getElementById("tab-historial").addEventListener("click", () => { estado.tab = "historial"; render(); });

  async function iniciar() {
    try {
      [estado.picks, estado.historial] = await Promise.all([
        cargarJSON("data/picks.json"),
        cargarJSON("data/historial.json"),
      ]);
    } catch (err) {
      document.getElementById("actualizado").textContent = "No se pudieron cargar los datos.";
      panel.replaceChildren(h("div", { class: "vacio" },
        h("strong", null, "No se pudieron cargar los datos."),
        "Si abriste index.html directo desde tu computador, usa un servidor local (por ejemplo: python3 -m http.server) o abre la versión publicada en GitHub Pages."));
      return;
    }
    if (estado.picks.niveles) UMBRALES = estado.picks.niveles;
    const gen = estado.picks.generado;
    document.getElementById("actualizado").textContent =
      gen ? "Actualizado el " + fmtActualizado.format(new Date(gen)) : "Aún sin datos";

    const avisos = document.getElementById("avisos");
    (estado.picks.avisos || []).slice(0, 2).forEach((a) =>
      avisos.append(h("p", { class: "aviso" }, "Aviso de la API: " + a)));
    render();
  }

  // Tocar cualquier cosa fuera del partido abierto (botones, filtros, pestañas, fondo) lo recoge.
  document.addEventListener("click", (e) => {
    if (estado.abierto === null) return;
    const t = e.target.closest ? e.target.closest(".partido") : null;
    if (!t || t.dataset.id !== String(estado.abierto)) fijarAbierto(null);
  });

  iniciar();
})();
