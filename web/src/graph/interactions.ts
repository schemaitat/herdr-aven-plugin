import type { Core } from 'cytoscape';
import type { ElementDefinition } from 'cytoscape';
import type { Position } from './layout.js';

export interface GraphMemory {
  positions: Map<string, Position>;
  pins?: Map<string, Position>;
  visual?: Map<string, Position>;
  camera?: { zoom: number; pan: Position };
  commandSerial?: number;
}

export function syncElements(cy: Core, next: ElementDefinition[], positions: Map<string, Position>, initial: Map<string, Position>, remember = true) {
  const ids = new Set(next.map(element => element.data.id));
  cy.batch(() => {
    if (remember) cy.nodes().forEach(node => { positions.set(node.id(), { ...node.position() }); });
    cy.elements().filter(element => !ids.has(element.id())).remove();
    // Nodes precede edges; retained nodes never receive a new position or layout.
    for (const element of next) {
      const existing = cy.getElementById(element.data.id!);
      if (existing.length) {
        const current = existing.data();
        // Do not invalidate styles/geometry for unchanged snapshot elements.
        if (Object.keys(element.data).some(key => current[key] !== element.data[key])) existing.data(element.data);
      }
      else cy.add({ ...element, position: positions.get(element.data.id!) ?? initial.get(element.data.id!) });
    }
  });
}

export function highlight(cy: Core, selected?: string) {
  cy.batch(() => {
    cy.elements().removeClass('selected neighbor muted');
    const element = selected ? cy.collection(cy.getElementById(selected)) : cy.collection();
    if (!element.length) return;
    const neighborhood = element.nodes().length ? element.closedNeighborhood() : element.union(element.connectedNodes());
    cy.elements().difference(neighborhood).addClass('muted');
    neighborhood.addClass('neighbor');
    element.addClass('selected');
  });
}
