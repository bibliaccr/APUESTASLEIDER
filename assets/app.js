(() => {
  "use strict";

  const ZONA = "America/Bogota";
  const NIVELES = {
    super:    { nombre: "Súper confiada",         rango: 3 },
    confiada: { nombre: "Confiada",               rango: 2 },
    media:    { nombre: "Medianamente confiada",  rango: 1 },
  };

  const estado = { tab: "picks", nivel: "todos", liga: "todas", picks: null, historial: null };
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
    const ligas = [...new Set(partidos.map((p) => p.liga.nombre))];
    const chips = [
      h("button", { class: "chip", type: "button", "aria-pressed": estado.nivel === "todos",
        onclick: () => { estado.nivel = "todos"; render(); } }, "Todos los niveles"),
      ...Object.entries(NIVELES).map(([clave, n]) =>
        h("button", { class: "chip", type: "button", "aria-pressed": estado.nivel === clave,
          onclick: () => { estado.nivel = clave; render(); } }, medidor(clave), n.nombre)),
    ];
    const select = h("select", { class: "chip", "aria-label": "Liga",
      onchange: (e) => { estado.liga = e.target.value; render(); } },
      h("option", { value: "todas" }, "Todas las ligas"),
      ligas.map((l) => h("option", { value: l, selected: estado.liga === l }, l)));
    return h("div", { class: "filtros" }, chips, select);
  }

  function tarjetaPartido(p) {
    const a = p.analisis;
    const pick = (pk) =>
      h("li", { class: "pick", "data-nivel": pk.nivel },
        medidor(pk.nivel),
        h("div", null,
          h("div", { class: "pick-texto" }, pk.texto),
          h("div", { class: "pick-nivel" }, NIVELES[pk.nivel].nombre)),
        h("div", { class: "pick-prob" }, pk.prob, h("small", null, "%")),
        pk.ajuste ? h("p", { class: "pick-ajuste" }, pk.ajuste) : null);

    const fila = (izq, etq, der) => [h("div", null, izq), h("div", { class: "etq" }, etq), h("div", { class: "der" }, der)];
    const pc = (v) => (v || v === 0 ? Math.round(v) + "%" : "–");
    const dec = (v) => (v || v === 0 ? Number(v).toFixed(2) : "–");

    const analisis = h("details", { class: "analisis" },
      h("summary", null, "Ver análisis"),
      h("div", { class: "datos" },
        fila(pc(a.percent.home), "Gana local / visitante", pc(a.percent.away)),
        fila("", "Empate " + pc(a.percent.draw), ""),
        fila(dec(a.goles_esp.home), "Goles esperados", dec(a.goles_esp.away)),
        fila(pc(a.ultimos5.home), "Puntos en los últimos 5", pc(a.ultimos5.away)),
        fila(dec(a.gf.home), "Goles a favor por partido", dec(a.gf.away)),
        fila(dec(a.gc.home), "Goles en contra por partido", dec(a.gc.away)),
        fila(a.jugados.home, "Partidos jugados", a.jugados.away)),
      h("p", { class: "consejo" },
        h("strong", null, "Goles: "),
        `más de 2.5 → ${pc(a.mas25)}. Ambos marcan → ${pc(a.ambos)}.`),
      a.h2h && a.h2h.length
        ? [h("p", { class: "consejo" }, h("strong", null, "Últimos cruces")),
           h("ul", { class: "h2h" }, a.h2h.map((x) =>
             h("li", null, `${fmtCorta.format(new Date(x.fecha))}: ${x.local} ${x.gl ?? "-"} - ${x.gv ?? "-"} ${x.visita}`)))]
        : null);

    return h("article", { class: "partido", "data-nivel": p.nivel_max || "ninguno" },
      h("div", { class: "partido-cab" },
        h("span", { class: "liga" }, imagen(p.liga.logo), p.liga.nombre),
        h("span", { class: "hora" }, fmtHora.format(new Date(p.fecha)))),
      h("div", { class: "equipos" },
        h("div", { class: "equipo" }, imagen(p.local.logo), p.local.nombre),
        h("span", { class: "vs" }, "vs"),
        h("div", { class: "equipo visita" }, p.visitante.nombre, imagen(p.visitante.logo))),
      p.picks.length
        ? h("ul", { class: "picks" }, p.picks.map(pick))
        : h("p", { class: "sin-pick" }, "Sin pick: ninguna opción llega al mínimo de confianza."),
      analisis);
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
    if (estado.liga !== "todas") lista = lista.filter((p) => p.liga.nombre === estado.liga);

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
      partidos.sort((a, b) => rango(b) - rango(a) || a.fecha.localeCompare(b.fecha));
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
    const gen = estado.picks.generado;
    document.getElementById("actualizado").textContent =
      gen ? "Actualizado el " + fmtActualizado.format(new Date(gen)) : "Aún sin datos";

    const avisos = document.getElementById("avisos");
    (estado.picks.avisos || []).slice(0, 2).forEach((a) =>
      avisos.append(h("p", { class: "aviso" }, "Aviso de la API: " + a)));
    render();
  }

  iniciar();
})();
