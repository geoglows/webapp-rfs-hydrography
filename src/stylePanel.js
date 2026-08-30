import {compact, orderVisibilityWarning} from './streamAttributes.js';
import {
  BASE_LAYER_ID,
  cloneSpec,
  COLORS,
  defaultSpec,
  describeConditions,
  fmtZoom,
  MATCH_MODES,
  newCondition,
  newRule,
  opsFor,
  parseStyleJson,
  presetsFor,
  ruleLayerId,
  shadowedRules,
  styleJson,
  ZOOM_STEPS,
} from './streamStyle.js';

const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of [].concat(kids)) if (kid) n.appendChild(kid);
  return n;
};

const select = (options, value, onchange, cls = '') => {
  const s = el('select', {class: cls, onchange});
  for (const o of options) {
    const opt = el('option', {value: String(o.value), text: o.label});
    if (String(o.value) === String(value)) opt.selected = true;
    s.appendChild(opt);
  }
  return s;
};

const zoomOptions = (withNone, noneLabel = '—') => [
  ...(withNone ? [{value: '', label: noneLabel}] : []),
  ...ZOOM_STEPS.map(z => ({value: z, label: fmtZoom(z)})),
];

const num = v => (v === '' || v == null ? null : Number(v));

export function createStylePanel({mount, onChange, selection, pmtiles}) {
  let spec = defaultSpec();
  let attributes = [];
  let attrError = '';
  let presets = [];
  let highlight = true;
  const collapsed = new Set();
  let counts = new Map();
  let pending = null;

  const byName = () => new Map(attributes.map(a => [a.name, a]));
  const attrOf = name => byName().get(name);

  /** Which compiled layer each enabled rule became — the counts and the swatches key off this. */
  const layerIds = () => {
    const out = new Map();
    let i = 0;
    for (const r of spec.rules) if (r.enabled !== false) out.set(r.id, ruleLayerId(i++));
    return out;
  };

  // Values coalesce into one repaint per frame; structure repaints and rebuilds immediately.
  const changed = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      onChange();
    });
  };
  const restructured = () => {
    render();
    onChange();
  };

  // ── attribute menu ─────────────────────────────────────────────────────────
  function attrRow(a) {
    const range = a.type === 'string'
      ? `${a.values.length} value${a.values.length === 1 ? '' : 's'}`
      : (a.min == null ? 'number' : `${compact(a.min)} – ${compact(a.max)}`);
    return el('div', {class: `attr attr-${a.role}`}, [
      el('div', {class: 'attr-top'}, [
        el('span', {class: 'attr-label', text: a.label}),
        el('button', {
          class: 'mini', title: `Add an attribute styling rule for reaches matching a condition on ${a.name}`,
          onclick: () => {
            spec.rules.unshift(newRule({
              name: a.label, conditions: [newCondition(a)],
            }));
            restructured();
          },
          text: '+ rule',
        }),
        el('button', {
          class: 'mini', title: `Add a global visibility filter — draw only the reaches matching a condition on ${a.name}`,
          onclick: () => {
            spec.filter.conditions.push(newCondition(a));
            restructured();
          },
          text: '+ filter',
        }),
      ]),
      el('div', {class: 'attr-meta', text: `${a.name} · ${a.type} · ${range}`}),
      a.note ? el('div', {class: 'attr-note', text: a.note}) : null,
    ]);
  }

  function attributeMenu() {
    const box = el('details', {class: 'attr-menu', open: attributes.length <= 12});
    box.appendChild(el('summary', {
      text: attributes.length
        ? `Attributes in the tiles (${attributes.length})`
        : `Attributes unavailable${attrError ? ` — ${attrError}` : ''}`,
    }));
    if (!attributes.length) return box;
    const roles = [['measure', 'Measures — what to style by'], ['category', 'Categories — what to filter by'],
      ['identity', 'Identifiers — one reach each']];
    for (const [role, title] of roles) {
      const rows = attributes.filter(a => a.role === role);
      if (!rows.length) continue;
      box.appendChild(el('div', {class: 'attr-group', text: title}));
      for (const a of rows) box.appendChild(attrRow(a));
    }
    return box;
  }

  // ── conditions ─────────────────────────────────────────────────────────────
  function conditionRow(list, i, onRemove) {
    const c = list[i];
    const a = attrOf(c.attribute);
    const ops = opsFor(c.type);
    const row = el('div', {class: 'cond'});

    row.appendChild(select(
      attributes.length
        ? attributes.map(x => ({value: x.name, label: x.label}))
        : [{value: c.attribute, label: c.attribute}],
      c.attribute,
      e => {
        list[i] = newCondition(attrOf(e.target.value));
        restructured();
      },
      'cond-attr',
    ));
    row.appendChild(select(ops.map(o => ({value: o.op, label: o.label})), c.op, e => {
      c.op = e.target.value;
      restructured();
    }, 'cond-op'));

    if (c.type === 'string' && c.op !== 'in' && a?.values?.length) {
      row.appendChild(select(a.values.map(v => ({value: v, label: v})), c.value, e => {
        c.value = e.target.value;
        changed();
      }, 'cond-val'));
    } else {
      row.appendChild(el('input', {
        class: 'cond-val', type: c.type === 'string' ? 'text' : 'number', value: c.value ?? '',
        placeholder: c.op === 'in' ? 'a, b, c' : '',
        oninput: e => {
          c.value = c.type === 'string' ? e.target.value : num(e.target.value);
          changed();
        },
      }));
      if (c.op === 'between') {
        row.appendChild(el('input', {
          class: 'cond-val', type: 'number', value: c.value2 ?? '',
          oninput: e => {
            c.value2 = num(e.target.value);
            changed();
          },
        }));
      }
    }
    row.appendChild(el('button', {class: 'mini x', text: '✕', title: 'Remove condition', onclick: onRemove}));
    return row;
  }

  function conditionList(owner, {addLabel}) {
    const list = owner.conditions;
    const box = el('div', {class: 'conds'});
    list.forEach((_, i) => box.appendChild(conditionRow(list, i, () => {
      list.splice(i, 1);
      restructured();
    })));
    box.appendChild(el('div', {class: 'conds-foot'}, [
      el('button', {
        class: 'mini add', text: addLabel,
        onclick: () => {
          list.push(newCondition(attributes.find(a => a.role === 'measure') ?? attributes[0]));
          restructured();
        },
      }),
      ...(list.length > 1 ? [
        el('span', {class: 'stops-label', text: 'MATCH'}),
        ...MATCH_MODES.map(m => el('button', {
          class: `seg${(owner.match ?? 'all') === m.mode ? ' on' : ''}`, text: m.label, title: m.hint,
          onclick: () => {
            owner.match = m.mode;
            restructured();
          },
        })),
      ] : []),
    ]));
    return box;
  }

  // ── stops ──────────────────────────────────────────────────────────────────
  const STOP_INPUT = {
    color: {type: 'color', step: null},
    width: {type: 'number', step: 0.1, min: 0, max: 24},
    opacity: {type: 'number', step: 0.05, min: 0, max: 1},
  };

  function stopsEditor(block, prop, label) {
    const stops = block[prop];
    const box = el('div', {class: 'stops'});
    box.appendChild(el('div', {class: 'stops-head'}, [
      el('span', {class: 'stops-label', text: label}),
      el('span', {
        class: 'stops-count',
        text: stops.length > 1 ? `${stops.length} zoom stops` : 'constant'
      }),
      el('button', {
        class: 'mini add', text: '+ zoom', title: 'Add a stop at another zoom',
        onclick: () => {
          const last = stops[stops.length - 1] ?? {zoom: 0, value: STOP_INPUT[prop].type === 'color' ? COLORS.stream : 1};
          const next = ZOOM_STEPS.find(z => z > last.zoom) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
          stops.push({zoom: next, value: last.value});
          restructured();
        },
      }),
    ]));
    stops.forEach((s, i) => {
      const cfg = STOP_INPUT[prop];
      const row = el('div', {class: 'stop'}, [
        select(zoomOptions(false), s.zoom, e => {
          s.zoom = Number(e.target.value);
          restructured();
        }, 'stop-zoom'),
        el('input', {
          class: 'stop-val', type: cfg.type, value: s.value,
          step: cfg.step ?? false, min: cfg.min ?? false, max: cfg.max ?? false,
          oninput: e => {
            s.value = cfg.type === 'color' ? e.target.value : Number(e.target.value);
            if (prop === 'color' && i === 0) paintSwatches();
            changed();
          },
        }),
        stops.length > 1
          ? el('button', {
            class: 'mini x', text: '✕', title: 'Remove stop',
            onclick: () => {
              stops.splice(i, 1);
              restructured();
            }
          })
          : null,
      ]);
      box.appendChild(row);
    });
    return box;
  }

  function zoomRange(block) {
    return el('div', {class: 'zrange'}, [
      el('span', {class: 'stops-label', text: 'VISIBLE'}),
      select(zoomOptions(true, 'z0'), block.minZoom ?? '', e => {
        block.minZoom = num(e.target.value);
        if (block.maxZoom != null && block.minZoom != null && block.maxZoom <= block.minZoom) {
          block.maxZoom = null;
        }
        restructured();
      }, 'zsel'),
      el('span', {class: 'zsep', text: 'to'}),
      select(zoomOptions(true, 'max'), block.maxZoom ?? '', e => {
        block.maxZoom = num(e.target.value);
        if (block.minZoom != null && block.maxZoom != null && block.maxZoom <= block.minZoom) {
          block.minZoom = null;
        }
        restructured();
      }, 'zsel'),
      el('span', {
        class: 'hint', title: 'MapLibre hides a layer at and above its maxzoom',
        text: block.maxZoom != null ? '(hidden at and above)' : ''
      }),
    ]);
  }

  // ── rules ──────────────────────────────────────────────────────────────────
  function styleBlock(block) {
    return el('div', {class: 'block-style'}, [
      stopsEditor(block, 'color', 'COLOUR'),
      stopsEditor(block, 'width', 'WIDTH'),
      stopsEditor(block, 'opacity', 'OPACITY'),
      zoomRange(block),
    ]);
  }

  function ruleCard(rule, i, shadowed) {
    const ids = layerIds();
    const open = !collapsed.has(rule.id);
    const swatch = el('span', {class: 'rule-swatch'});
    swatch.style.background = rule.color[0]?.value ?? '#888';
    const n = counts.get(ids.get(rule.id));

    const head = el('div', {class: 'rule-head'}, [
      el('input', {
        type: 'checkbox', class: 'rule-on', checked: rule.enabled !== false,
        title: 'Draw this rule', onchange: e => {
          rule.enabled = e.target.checked;
          restructured();
        },
      }),
      swatch,
      el('input', {
        type: 'text', class: 'rule-name', value: rule.name,
        oninput: e => {
          rule.name = e.target.value;
          changed();
        },
      }),
      el('button', {
        class: 'mini', text: '▲', title: 'Higher priority', disabled: i === 0,
        onclick: () => {
          spec.rules.splice(i - 1, 0, spec.rules.splice(i, 1)[0]);
          restructured();
        }
      }),
      el('button', {
        class: 'mini', text: '▼', title: 'Lower priority', disabled: i === spec.rules.length - 1,
        onclick: () => {
          spec.rules.splice(i + 1, 0, spec.rules.splice(i, 1)[0]);
          restructured();
        }
      }),
      el('button', {
        class: 'mini x', text: '✕', title: 'Delete rule',
        onclick: () => {
          spec.rules.splice(i, 1);
          collapsed.delete(rule.id);
          restructured();
        }
      }),
      el('button', {
        class: 'mini caret', text: open ? '▾' : '▸', title: open ? 'Collapse' : 'Expand',
        onclick: () => {
          if (open) collapsed.add(rule.id); else collapsed.delete(rule.id);
          render();
        }
      }),
    ]);

    const card = el('div', {class: `rule${rule.enabled === false ? ' off' : ''}${open ? ' open' : ''}`}, [head]);
    const summary = describeConditions(rule.conditions, byName(), rule.match) || 'every reach';
    card.appendChild(el('div', {class: 'rule-summary'}, [
      el('span', {text: summary}),
      el('span', {class: 'rule-count', text: n == null ? '' : `≈${n.toLocaleString()} on screen`}),
    ]));

    if (shadowed) {
      card.appendChild(el('div', {
        class: 'warn',
        text: 'never applies — a rule above it already matches every reach'
      }));
    }
    for (const c of rule.conditions) {
      const w = orderVisibilityWarning(c, rule.minZoom);
      if (w) card.appendChild(el('div', {class: 'warn', text: `${w} — the tiles carry nothing lower`}));
    }
    if (!open) return card;

    card.appendChild(el('div', {class: 'rule-when'}, [
      el('span', {class: 'stops-label', text: 'WHEN'}),
      conditionList(rule, {addLabel: '+ condition'}),
    ]));
    card.appendChild(styleBlock(rule));
    return card;
  }

  // ── header controls ────────────────────────────────────────────────────────
  function toolbar() {
    const sel = selection();
    const scopeBtn = (mode, label, title) => el('button', {
      class: `seg${spec.scope === mode ? ' on' : ''}`, text: label, title,
      disabled: mode === 'selection' && !sel,
      onclick: () => {
        spec.scope = mode;
        restructured();
      },
    });

    return el('div', {class: 'style-toolbar'}, [
      el('div', {class: 'row'}, [
        select([{value: '', label: 'Preset…'}, ...presets.map(p => ({value: p.id, label: p.label}))], '',
          e => {
            const p = presets.find(x => x.id === e.target.value);
            e.target.value = '';
            if (!p) return;
            const keepScope = spec.scope;
            spec = p.build();
            spec.scope = keepScope;
            collapsed.clear();
            for (const r of spec.rules) collapsed.add(r.id);
            restructured();
          }, 'preset'),
        el('button', {
          class: 'mini', text: '+ rule', title: 'Add an empty rule',
          onclick: () => {
            spec.rules.unshift(newRule({name: `Rule ${spec.rules.length + 1}`}));
            restructured();
          }
        }),
      ]),
      el('div', {class: 'row'}, [
        el('span', {class: 'stops-label', text: 'PREVIEW'}),
        scopeBtn('all', 'All streams', 'Style every reach on the map'),
        scopeBtn('selection', 'Selection', sel
          ? `Fade everything outside the ${sel.count.toLocaleString()}-reach subset`
          : 'Select a river first'),
      ]),
      el('label', {class: 'row check'}, [
        el('input', {
          type: 'checkbox', checked: highlight,
          onchange: e => {
            highlight = e.target.checked;
            onChange();
          }
        }),
        el('span', {text: 'Keep the selection highlight over the style'}),
      ]),
    ]);
  }

  function footer() {
    const file = el('input', {
      type: 'file', accept: 'application/json,.json', class: 'hidden',
      onchange: e => loadFile(e.target.files?.[0])
    });
    return el('div', {class: 'style-footer'}, [
      el('button', {class: 'primary', text: 'Download JSON', onclick: download}),
      el('button', {text: 'Load', title: 'Read a style JSON back in', onclick: () => file.click()}),
      el('button', {
        text: 'Reset', title: 'Back to the v3 default',
        onclick: () => {
          spec = defaultSpec();
          collapsed.clear();
          restructured();
        }
      }),
      file,
    ]);
  }

  // ── file in and out ────────────────────────────────────────────────────────
  const json = () => styleJson(spec, {pmtiles, selection: selection()});

  function download() {
    const sel = selection();
    const name = spec.scope === 'selection' && sel
      ? `rfs_v3_group${sel.groupId}_${sel.outletId}_stream_style.json`
      : 'rfs_v3_stream_style.json';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(json(), null, 2)], {type: 'application/json'}));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function loadFile(f) {
    if (!f) return;
    try {
      const parsed = parseStyleJson(JSON.parse(await f.text()));
      spec = parsed.spec;
      collapsed.clear();
      for (const r of spec.rules) collapsed.add(r.id);
      restructured();
    } catch (err) {
      console.error('[style] load failed', err);
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────
  function paintSwatches() {
    for (const [i, node] of [...mount.querySelectorAll('.rule')].entries()) {
      const s = node.querySelector('.rule-swatch');
      if (s && spec.rules[i]) s.style.background = spec.rules[i].color[0]?.value ?? '#888';
    }
  }

  function render() {
    const scroll = mount.scrollTop;
    mount.replaceChildren();
    mount.appendChild(toolbar());
    mount.appendChild(attributeMenu());

    const shadow = shadowedRules(spec);
    const filterBox = el('section', {class: 'style-section'}, [
      el('h3', {}, [
        el('span', {text: 'Global Visibility Filters'}),
        el('span', {class: 'hint', text: spec.filter.conditions.length ? 'reaches outside them are not drawn' : 'none — every reach is drawn'}),
      ]),
      conditionList(spec.filter, {addLabel: '+ condition'}),
    ]);
    mount.appendChild(filterBox);

    const rulesBox = el('section', {class: 'style-section'}, [
      el('h3', {}, [
        el('span', {text: `Attribute Styling Rules (${spec.rules.length})`}),
        el('span', {class: 'hint', text: 'first match wins'}),
      ]),
    ]);
    spec.rules.forEach((r, i) => rulesBox.appendChild(ruleCard(r, i, shadow.has(r.id))));
    mount.appendChild(rulesBox);

    const n = counts.get(BASE_LAYER_ID);
    mount.appendChild(el('section', {class: 'style-section'}, [
      el('h3', {}, [
        el('input', {
          type: 'text', class: 'rule-name base-name', value: spec.base.name,
          title: 'What the base style is called in the exported file',
          oninput: e => {
            spec.base.name = e.target.value;
            changed();
          }
        }),
        el('span', {
          class: 'rule-count base-count',
          text: n == null ? 'everything no rule claimed' : `≈${n.toLocaleString()} on screen`
        }),
      ]),
      styleBlock(spec.base),
    ]));

    mount.appendChild(footer());
    mount.scrollTop = scroll;
  }

  render();

  return {
    /** The tiles' attribute list, once the archive metadata has been read. */
    setAttributes({attributes: list = [], error = ''} = {}) {
      attributes = list;
      attrError = error;
      presets = presetsFor(list);
      render();
    },
    /** Approximate rendered-feature counts per compiled layer, keyed by layer id. */
    setCounts(next) {
      counts = next;
      const ids = layerIds();
      for (const [i, node] of [...mount.querySelectorAll('.rule')].entries()) {
        const n = counts.get(ids.get(spec.rules[i]?.id));
        const slot = node.querySelector('.rule-count');
        if (slot) slot.textContent = n == null ? '' : `≈${n.toLocaleString()} on screen`;
      }
      const base = counts.get(BASE_LAYER_ID);
      const slot = mount.querySelector('.base-count');
      if (slot && base != null) slot.textContent = `≈${base.toLocaleString()} on screen`;
    },
    /** A selection appeared or went away — the scope control depends on it. */
    selectionChanged() {
      render();
    },
    getSpec: () => spec,
    setSpec(next) {
      spec = cloneSpec(next);
      collapsed.clear();
      restructured();
    },
    options: () => ({highlight}),
    json,
    download,
  };
}
