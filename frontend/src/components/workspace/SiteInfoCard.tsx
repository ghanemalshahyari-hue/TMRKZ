import type { StationingRecord } from '../../api/types';
import { familyOf, type RefSite, type SiteFamilyView } from '../../lib/sitesLayer';
import { fullDate } from '../../lib/dates';
import { Icon } from '../ui';

/**
 * What a registered site is, on a click (owner decision of 5 Nov 2026, items 4–5): name, kind, responsible organisation,
 * its registered boundary or marker, and the current stationing at it when this person may see it. Information only: it
 * never changes a request, and a registered site is not offered as the proposed location (activation registers a new
 * site from the submitted geometry).
 */
export function SiteInfoCard({ site, current, onClose, sites = [], onSelect }: { site: RefSite; current: StationingRecord[]; onClose: () => void; sites?: RefSite[]; onSelect?: (siteId: string) => void }) {
  const here = current.filter((c) => c.siteId === site.siteId);
  const family = familyOf(sites, site.siteId);
  return (
    <div className="tz-site-card" role="dialog" aria-label={'معلومات الموقع «' + site.name + '»'} data-testid="site-info">
      <div className="tz-site-card-head">
        <b>{site.name}</b>
        <button className="tz-site-card-close" aria-label="إغلاق" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <dl>
        <div>
          <dt>النوع</dt>
          <dd>{site.kind || '—'} · {site.code}</dd>
        </div>
        <div>
          <dt>الجهة المسؤولة</dt>
          <dd>{site.responsibleOrg?.name ?? '—'}</dd>
        </div>
        <div>
          <dt>الحدود</dt>
          <dd>{!site.onMap ? 'موقع غير معروض على الخريطة' : site.geometry && site.geometry.type !== 'Point' ? `حدود مسجلة (${site.geometry.type === 'MultiPolygon' ? 'مضلع متعدد' : 'مضلع'})` : 'علامة موقع فقط'}</dd>
        </div>
        <div>
          <dt>التمركز الحالي</dt>
          <dd>{here.length ? here.map((c) => `${c.orgName} (${c.kind === 'TEMPORARY' ? 'مؤقت' : 'دائم'} منذ ${fullDate(c.validFrom)})`).join('، ') : 'لا تمركز ظاهر لك'}</dd>
        </div>
        <SiteFamily family={family} onSelect={onSelect} />
      </dl>
      <small className="tz-muted">موقع مسجّل للمرجع فقط — لا يغيّر الطلب.</small>
    </div>
  );
}

/** «يتبع الموقع»، «المواقع التابعة» and «مواقع في المجمع نفسه»: the site's family in the register; a name opens that site. */
export function SiteFamily({ family, onSelect }: { family: SiteFamilyView; onSelect?: (siteId: string) => void }) {
  const name = (s: RefSite) => (onSelect ? <button className="link tz-family-link" onClick={() => onSelect(s.siteId)}>{s.name}</button> : <span>{s.name}</span>);
  return (
    <>
      {family.parent && (
        <div>
          <dt>يتبع الموقع</dt>
          <dd>{name(family.parent)}</dd>
        </div>
      )}
      <div>
        <dt>المواقع التابعة</dt>
        <dd data-testid="site-children">
          {family.children.length === 0 ? (
            'لا مواقع فرعية مسجلة تحته'
          ) : (
            <ul className="tz-family">
              {family.children.map((c) => (
                <li key={c.siteId}>{name(c)}</li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      {family.siblings.length > 0 && (
        <div>
          <dt>مواقع في المجمع نفسه</dt>
          <dd data-testid="site-siblings">
            <ul className="tz-family">
              {family.siblings.map((c) => (
                <li key={c.siteId}>{name(c)}</li>
              ))}
            </ul>
          </dd>
        </div>
      )}
    </>
  );
}

