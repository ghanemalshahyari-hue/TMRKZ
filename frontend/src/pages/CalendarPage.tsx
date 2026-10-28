import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { AvailabilityGrid, MapFeature, ReservationItem } from '../api/types';
import { MapView, type MapMode } from '../components/MapView';
import { Heading } from '../components/ui';
import { facilitySites, useApp } from '../lib/app';
import { addDays, dayLabel, dubaiISO, fullDate, todayDubai } from '../lib/dates';
import { RESERVATION_STATUS } from '../lib/labels';

export function CalendarPage() {
  const app = useApp();
  const { sites, selectedSiteId, setSelectedSiteId, summaryOnly, revision } = app;
  const [weekStart, setWeekStart] = useState(() => todayDubai());
  const [dayIndex, setDayIndex] = useState(0);
  const [grid, setGrid] = useState<AvailabilityGrid | null>(null);
  const [features, setFeatures] = useState<MapFeature[]>([]);
  const [reservations, setReservations] = useState<ReservationItem[]>([]);
  const [mode, setMode] = useState<MapMode>('availability');
  const [error, setError] = useState<string | null>(null);
  const day = grid?.days[dayIndex] ?? addDays(weekStart, dayIndex);

  useEffect(() => {
    api
      .availabilityGrid(weekStart, 7)
      .then((g) => (setGrid(g), setError(null)))
      .catch((e: Error) => setError(e.message));
    api
      .reservations({ from: dubaiISO(weekStart), to: dubaiISO(addDays(weekStart, 7)) })
      .then(setReservations)
      .catch(() => setReservations([]));
  }, [weekStart, revision]);

  useEffect(() => {
    api
      .mapFeatures(dubaiISO(day))
      .then((d) => setFeatures(d.features))
      .catch(() => setFeatures([]));
    app.setMapDate(day);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, revision]);

  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const rows = useMemo(() => {
    const order = new Map(facilitySites(sites).map((s, i) => [s.id, i]));
    return (grid?.rows ?? []).filter((r) => siteById.has(r.siteId)).sort((a, b) => (order.get(a.siteId) ?? 99) - (order.get(b.siteId) ?? 99));
  }, [grid, sites, siteById]);
  const selected = rows.find((r) => r.siteId === selectedSiteId)?.siteId ?? rows[0]?.siteId ?? null;
  const selectedSite = selected ? siteById.get(selected) : undefined;
  const siteBookings = reservations.filter((r) => r.resource.siteId === selected && r.status === 'ACTIVE');

  const pick = (siteId: string, i: number) => {
    setSelectedSiteId(siteId);
    setDayIndex(i);
  };

  return (
    <>
      <Heading
        en="CALENDAR / SPACE OVER TIME"
        title="الإشغال عبر الزمن"
        description="حالة المرفق تتبع الفترة؛ سجل الموقع يحتفظ بهويته."
        actions={
          <>
            <button className="button compact" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="الأسبوع السابق">
              → السابق
            </button>
            <span className="pill">
              {fullDate(dubaiISO(weekStart))} — {fullDate(dubaiISO(addDays(weekStart, 6)))}
            </span>
            <button className="button compact" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="الأسبوع التالي">
              التالي ←
            </button>
          </>
        }
      />
      {error && <div className="note red" style={{ marginBottom: 15 }}>{error}</div>}
      <div className="calendar-layout">
        <div className="stack">
          <MapView className="calendar-map" features={features} selectedSiteId={selected} onSelect={setSelectedSiteId} mode={mode} onModeChange={setMode} />
          <section className="card">
            <div className="column-heading flex spread">
              <h3>جدول إشغال المرافق</h3>
              <span className="micro muted">اختر خلية لتغيير الموقع واليوم</span>
            </div>
            <div className="table-scroll">
              <div className="calendar-grid">
                <div className="day-head row-name">المرفق / الأسبوع</div>
                {(grid?.days ?? Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))).map((d) => (
                  <div key={d} className="day-head">
                    {dayLabel(d)}
                  </div>
                ))}
                {rows.map((row) => {
                  const s = siteById.get(row.siteId)!;
                  return (
                    <Fragment key={row.siteId}>
                      <div className="row-name">
                        <button onClick={() => setSelectedSiteId(row.siteId)}>{s.name}</button>
                      </div>
                      {row.cells.map((c, i) => (
                        <div
                          key={i}
                          role="button"
                          tabIndex={0}
                          className={'time-cell ' + (dayIndex === i && selected === row.siteId ? 'active' : '')}
                          aria-label={s.name + ' ' + dayLabel(grid!.days[i]) + ' ' + (c === 'BUSY' ? 'محجوز' : c === 'PENDING' ? 'طلب قيد المراجعة' : 'متاح')}
                          onClick={() => pick(row.siteId, i)}
                          onKeyDown={(e) => e.key === 'Enter' && pick(row.siteId, i)}
                        >
                          <span className={'booking-line ' + (c === 'PENDING' ? 'pending' : c === 'FREE' ? 'free' : '')} />
                        </div>
                      ))}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          </section>
        </div>
        <aside className="card calendar-side">
          <span className="eyebrow">DAY / {day.slice(8, 10)}</span>
          <h2>{fullDate(dubaiISO(day))}</h2>
          <div className="calendar-daylist">
            {Array.from({ length: 7 }, (_, i) => (
              <button key={i} className={dayIndex === i ? 'active' : ''} onClick={() => setDayIndex(i)}>
                {(grid?.days[i] ?? addDays(weekStart, i)).slice(8, 10)}
              </button>
            ))}
          </div>
          <div className="rule" />
          <h3>{selectedSite?.name ?? '—'}</h3>
          <p className="muted micro" style={{ margin: '7px 0 15px' }}>
            الحجوزات المعتمدة لهذا المرفق خلال الأسبوع
          </p>
          {siteBookings.map((x) => (
            <div key={x.id} className="calendar-booking">
              <b>{summaryOnly || !x.org ? 'حجز معتمد' : x.org.name}</b>
              <small>
                {x.resource.name} · {fullDate(x.period.start)} ← {fullDate(x.period.end)}
              </small>
              <br />
              <span className={'pill ' + (RESERVATION_STATUS[x.status]?.[1] ?? '')}>{RESERVATION_STATUS[x.status]?.[0] ?? x.status}</span>
              {x.requestNumber && <span className="latin tiny muted" style={{ marginInlineStart: 8 }}>{x.requestNumber}</span>}
            </div>
          ))}
          {!siteBookings.length && <p className="micro muted">لا توجد حجوزات معتمدة لهذا المرفق في الأسبوع المعروض.</p>}
          <div className="note" style={{ marginTop: 18 }}>
            الطلب البرتقالي لا يحجز المرفق حصرياً قبل الاعتماد.
          </div>
        </aside>
      </div>
    </>
  );
}
