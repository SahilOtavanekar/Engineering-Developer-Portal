import { useEffect, useState } from 'react';
import type { Entity } from '@backstage/catalog-model';
import { useApi } from '@backstage/core-plugin-api';
import Checkbox from '@material-ui/core/Checkbox';
import FormControlLabel from '@material-ui/core/FormControlLabel';
import CheckBoxIcon from '@material-ui/icons/CheckBox';
import CheckBoxOutlineBlankIcon from '@material-ui/icons/CheckBoxOutlineBlank';
import {
  catalogApiRef,
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
 * The dropdown's options, labelled with the project's real name.
 *
 * **`getOptionLabel` cannot do this and a bare `renderOption` loses the
 * counts.** `EntityAutocompletePicker` applies `getOptionLabel` to the input
 * text only; the option rows go through a default renderer that is handed the
 * facet counts internally, and a `renderOption` of our own receives
 * `(option, state)` and nothing else. So supplying one means sourcing both the
 * titles and the counts here.
 *
 * **One request, not two.** The first version fetched the Systems for their
 * titles and then `getEntityFacets` for the counts. The second call is
 * unnecessary: a System's `relations` already list its components, so
 * `hasPart` gives the count in the same response as the title. Verified
 * against the stored entities -- `hasPart` per System is 21 / 12 / 20 / 4 / 37
 * / 4, matching the facet exactly, and every part is a Component because this
 * catalog holds no Resources.
 *
 * If Resources are ever ingested, `hasPart` will exceed the component count
 * and the filter would advertise the wrong number. The guard is the
 * `component:` prefix test below rather than a comment.
 *
 * Falls back to the raw value whenever either is missing, so the control still
 * works while the requests are in flight, if a System has no title, or if a
 * project appears in `spec.system` with no System entity behind it.
 */
function useProjectLabels() {
  const catalog = useApi(catalogApiRef);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const systems = await catalog.getEntities({
        filter: { kind: 'System' },
        fields: ['metadata.name', 'metadata.title', 'relations'],
      });
      if (cancelled) return;
      setTitles(
        Object.fromEntries(
          systems.items
            .filter(e => e.metadata.title)
            .map(e => [e.metadata.name, e.metadata.title as string]),
        ),
      );
      setCounts(
        Object.fromEntries(
          systems.items.map(e => [
            e.metadata.name,
            (e.relations ?? []).filter(
              r => r.type === 'hasPart' && r.targetRef.startsWith('component:'),
            ).length,
          ]),
        ),
      );
    })().catch(() => {
      // A failed lookup must not break the filter -- it degrades to the raw
      // `spec.system` value, which is what the picker showed before this.
    });
    return () => {
      cancelled = true;
    };
  }, [catalog]);

  return (value: string) => {
    const label = titles[value] ?? value;
    const count = counts[value];
    return count === undefined ? label : `${label} (${count})`;
  };
}

const icon = <CheckBoxOutlineBlankIcon fontSize="small" />;
const checkedIcon = <CheckBoxIcon fontSize="small" />;

export function EntityProjectPicker(props: { hidden?: boolean }) {
  const labelFor = useProjectLabels();

  return (
    <EntityAutocompletePicker<ProjectEntityFilters, 'system'>
      label="Project"
      name="system"
      path="spec.system"
      Filter={EntityProjectFilter}
      /**
       * `getOptionLabel` covers the input text -- the chip left behind after a
       * selection -- and `renderOption` covers the list. Both are needed, or
       * the control disagrees with its own dropdown.
       */
      getOptionLabel={option => labelFor(option)}
      renderOption={(option, { selected }) => (
        <FormControlLabel
          control={
            <Checkbox
              icon={icon}
              checkedIcon={checkedIcon}
              checked={selected}
            />
          }
          label={labelFor(option)}
          /**
           * The stock option does this too: the label is inside the listbox's
           * own click target, so letting the control handle the event as well
           * toggles the selection twice and it appears not to respond.
           */
          onClick={event => event.preventDefault()}
        />
      )}
      hidden={props.hidden}
    />
  );
}
