import type { Entity } from '@backstage/catalog-model';
import {
  EntityAutocompletePicker,
  type DefaultEntityFilters,
  type EntityFilter,
} from '@backstage/plugin-catalog-react';

/**
 * Filters the catalog by Bitbucket project.
 *
 * **There is no stock filter for this.** `plugin-catalog` ships eight --
 * kind, type, user-list, owner, tag, lifecycle, namespace and
 * processing-status -- and none of them covers the System an entity belongs
 * to, which is what this portal renders as "Project". So it is built from
 * `EntityAutocompletePicker`, the generic primitive the Tag and Owner pickers
 * are themselves built from, plus the filter class below.
 *
 * A project is the single most useful way to slice this estate: every one of
 * the 98 components has one, and the six of them partition the catalog cleanly
 * -- MDLH 37, AM 21, DDS 20, DAARWYN 12, DAIWEB 4, RES 4. Tags, which this
 * replaced, carry a derived language and are absent on most rows.
 */

/**
 * `spec.system`, as a catalog filter.
 *
 * `values: string[]` is not a stylistic choice -- `AllowedEntityFilters`
 * requires that exact shape, and `EntityAutocompletePicker` will not accept a
 * filter class without it.
 *
 * Both halves are implemented, as `EntityTagFilter` does. `getCatalogFilters`
 * pushes the work to the catalog backend, which is what the page's offset
 * pagination needs -- it fetches a page at a time, so a frontend-only filter
 * would filter one page and report the wrong total. `filterEntity` covers the
 * paths that resolve entities client-side.
 */
export class EntityProjectFilter implements EntityFilter {
  constructor(readonly values: string[]) {}

  getCatalogFilters(): Record<string, string | string[]> {
    return { 'spec.system': this.values };
  }

  filterEntity(entity: Entity): boolean {
    const system = entity.spec?.system;
    return typeof system === 'string' && this.values.includes(system);
  }

  toQueryValue(): string[] {
    return this.values;
  }
}

/**
 * `DefaultEntityFilters` has no `system` key, so the picker's generics need
 * telling about one. This is the documented way to add a custom filter:
 * `EntityListContextProps` is generic over anything extending the defaults.
 */
type ProjectEntityFilters = DefaultEntityFilters & {
  system?: EntityProjectFilter;
};

/**
 * **The options are entity names, and the Project column shows titles -- so the
 * dropdown reads "mdlh (37)" where the column reads "MDLH". That is deliberate,
 * after trying the alternative.**
 *
 * `spec.system` holds the System's *name*, which `toSystemName` in the
 * Bitbucket entity provider lowercases, so the facet returns `mdlh`, `am`,
 * `dds`. The column renders the System's `title`, which is the project key as
 * Bitbucket has it.
 *
 * `getOptionLabel` looks like the fix and is not: `EntityAutocompletePicker`
 * applies it to the input text only. The option rows go through a default
 * `renderOption` that renders the raw value beside its count, and passing a
 * `renderOption` of our own is the only way past it -- but that callback
 * receives `(option, state)` and **not the counts**, which the picker holds
 * internally. Upper-casing the list therefore costs the "(37)" on every row.
 *
 * The counts are worth more than the casing: they say how much of the estate a
 * project accounts for, which is the reason to filter by it. So the values are
 * left as they are, and `getOptionLabel` is deliberately NOT passed -- upper-
 * casing the chip alone would leave the control disagreeing with its own
 * dropdown, which is worse than both being lower-case.
 */
export function EntityProjectPicker(props: { hidden?: boolean }) {
  return (
    <EntityAutocompletePicker<ProjectEntityFilters, 'system'>
      label="Project"
      name="system"
      path="spec.system"
      Filter={EntityProjectFilter}
      showCounts
      hidden={props.hidden}
    />
  );
}
