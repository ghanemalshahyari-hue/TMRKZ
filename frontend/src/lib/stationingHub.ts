import type { Permission } from '../api/types';
import { newRequestHashFor } from './requestPurpose';

/**
 * The three ways of stationing (owner reference, 17 Nov 2026, phase 1), as tabs of the top bar right after «الرئيسية» — one
 * click and the work opens, no page in between (owner, same day: "put them on the top as a tab … you can click, that's it"):
 * the initial stationing sites (the unit's first stationing, not a request), deployment areas (the current site stays) and
 * re-stationing (a new site). Deployment areas are never mixed with re-stationing. A way shows only to whoever may take it;
 * the server still decides every call.
 */
export type HubWay = {
  key: 'SITE_SETUP' | 'DEPLOYMENT_AREAS' | 'RESTATIONING';
  title: string;
  /** The tab's tooltip. */
  description: string;
  icon: string;
  /** Where the tab goes: the site setup, or the request editor with its purpose. */
  href: string;
  allowed: boolean;
};

export function hubWays(can: (p: Permission) => boolean): HubWay[] {
  const setup = can('MANAGE_FACILITIES') || can('MANAGE_SITE_LINKS') || can('CORRECT_STATIONING');
  const request = can('CREATE_RESTATIONING');
  return [
    {
      key: 'SITE_SETUP',
      // the owner's wording, 17 Nov 2026 (was «تهيئة موقع (معسكر)»)
      title: 'تحديد مواقع التمركز المبدئية',
      description: 'إنشاء موقع جديد وربطه بالوحدة (تمركز مبدئي)',
      icon: 'tent',
      href: '#siteSetup',
      allowed: setup,
    },
    {
      key: 'DEPLOYMENT_AREAS',
      title: 'طلب مناطق انتشار',
      description: 'إضافة أو تعديل منطقة الانتشار الرئيسية والفرعية للموقع الحالي',
      icon: 'layers',
      href: newRequestHashFor('DEPLOYMENT_AREAS'),
      allowed: request,
    },
    {
      key: 'RESTATIONING',
      title: 'طلب إعادة تمركز',
      description: 'نقل الوحدة إلى موقع جديد وتحديد مناطق الانتشار الجديدة',
      icon: 'swap',
      href: newRequestHashFor('RESTATIONING'),
      allowed: request,
    },
  ];
}
