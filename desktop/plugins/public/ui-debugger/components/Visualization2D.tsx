/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import React, {useEffect, useMemo, useRef} from 'react';
import {Bounds, Coordinate, Id, ClientNode} from '../ClientTypes';
import {NestedNode, OnSelectNode} from '../DesktopTypes';

import {produce, styled, theme, usePlugin, useValue} from 'flipper-plugin';
import {plugin} from '../index';
import {head, isEqual, throttle} from 'lodash';
import {Dropdown, Menu, Tooltip} from 'antd';
import {UIDebuggerMenuItem} from './util/UIDebuggerMenuItem';
import {useDelay} from '../hooks/useDelay';

export const Visualization2D: React.FC<
  {
    width: number;
    nodes: Map<Id, ClientNode>;
    onSelectNode: OnSelectNode;
  } & React.HTMLAttributes<HTMLDivElement>
> = ({width, nodes, onSelectNode}) => {
  const rootNodeRef = useRef<HTMLDivElement>();
  const instance = usePlugin(plugin);

  const snapshot = useValue(instance.snapshot);
  const snapshotNode = snapshot && nodes.get(snapshot.nodeId);
  const focusedNodeId = useValue(instance.uiState.focusedNode);

  const selectedNodeId = useValue(instance.uiState.selectedNode);
  const hoveredNodeId = head(useValue(instance.uiState.hoveredNodes));
  const focusState = useMemo(() => {
    //use the snapshot node as root since we cant realistically visualise any node above this
    const rootNode = snapshot && toNestedNode(snapshot.nodeId, nodes);
    return rootNode && caclulateFocusState(rootNode, focusedNodeId);
  }, [snapshot, nodes, focusedNodeId]);

  //this ref is to ensure the mouse has entered the visualiser, otherwise when you have overlapping modals
  //the hover state / tooltips all fire
  const visualizerActive = useRef(false);
  useEffect(() => {
    const mouseListener = throttle((ev: MouseEvent) => {
      const domRect = rootNodeRef.current?.getBoundingClientRect();

      if (
        !focusState ||
        !domRect ||
        instance.uiState.isContextMenuOpen.get() ||
        !snapshotNode ||
        !visualizerActive.current
      ) {
        return;
      }
      const rawMouse = {x: ev.clientX, y: ev.clientY};

      if (!boundsContainsCoordinate(domRect, rawMouse)) {
        return;
      }

      //make the mouse coord relative to the dom rect of the visualizer

      const pxScaleFactor = calcPxScaleFactor(snapshotNode.bounds, width);

      const offsetMouse = offsetCoordinate(rawMouse, domRect);
      const scaledMouse = {
        x: offsetMouse.x * pxScaleFactor,
        y: offsetMouse.y * pxScaleFactor,
      };

      const hitNodes = hitTest(focusState.focusedRoot, scaledMouse).map(
        (node) => node.id,
      );

      if (
        hitNodes.length > 0 &&
        !isEqual(hitNodes, instance.uiState.hoveredNodes.get())
      ) {
        instance.uiActions.onHoverNode(...hitNodes);
      }
    }, MouseThrottle);
    window.addEventListener('mousemove', mouseListener);

    return () => {
      window.removeEventListener('mousemove', mouseListener);
    };
  }, [
    instance.uiState.hoveredNodes,
    focusState,
    nodes,
    instance.uiState.isContextMenuOpen,
    width,
    snapshotNode,
    instance.uiActions,
  ]);

  useEffect(() => {
    return instance.uiState.isContextMenuOpen.subscribe((value) => {
      if (value === false) {
        visualizerActive.current = true;
      }
    });
  }, [instance.uiState.isContextMenuOpen]);

  if (!focusState || !snapshotNode) {
    return null;
  }

  const pxScaleFactor = calcPxScaleFactor(snapshotNode.bounds, width);

  return (
    <ContextMenu nodes={nodes}>
      <div
        onMouseLeave={(e) => {
          e.stopPropagation();
          //the context menu triggers this callback but we dont want to remove hover effect
          if (!instance.uiState.isContextMenuOpen.get()) {
            instance.uiActions.onHoverNode();
          }

          visualizerActive.current = false;
        }}
        onMouseEnter={() => {
          visualizerActive.current = true;
        }}
        //this div is to ensure that the size of the visualiser doesnt change when focusings on a subtree
        style={
          {
            overflowY: 'auto',
            overflowX: 'hidden',
            position: 'relative', //this is for the absolutely positioned overlays
            [pxScaleFactorCssVar]: pxScaleFactor,
            width: toPx(focusState.actualRoot.bounds.width),
            height: toPx(focusState.actualRoot.bounds.height),
          } as React.CSSProperties
        }>
        {hoveredNodeId && (
          <HoveredOverlay
            onSelectNode={instance.uiActions.onSelectNode}
            key={hoveredNodeId}
            nodeId={hoveredNodeId}
            nodes={nodes}
          />
        )}
        {selectedNodeId && (
          <OverlayBorder
            type="selected"
            nodeId={selectedNodeId.id}
            nodes={nodes}
          />
        )}
        <div
          ref={rootNodeRef as any}
          style={{
            /**
             * This relative position is so the rootNode visualization 2DNode and outer border has a non static element to
             * position itself relative to.
             *
             * Subsequent Visualization2DNode are positioned relative to their parent as each one is position absolute
             * which despite the name acts are a reference point for absolute positioning...
             *
             * When focused the global offset of the focussed node is used to offset and size this 'root' node
             */
            position: 'relative',
            marginLeft: toPx(focusState.focusedRootGlobalOffset.x),
            marginTop: toPx(focusState.focusedRootGlobalOffset.y),
            width: toPx(focusState.focusedRoot.bounds.width),
            height: toPx(focusState.focusedRoot.bounds.height),
            overflow: 'hidden',
          }}>
          {snapshotNode && (
            <img
              src={'data:image/png;base64,' + snapshot.data}
              style={{
                marginLeft: toPx(-focusState.focusedRootGlobalOffset.x),
                marginTop: toPx(-focusState.focusedRootGlobalOffset.y),
                width: toPx(snapshotNode.bounds.width),
                height: toPx(snapshotNode.bounds.height),
              }}
            />
          )}
          <MemoedVisualizationNode2D
            node={focusState.focusedRoot}
            onSelectNode={onSelectNode}
          />
        </div>
      </div>
    </ContextMenu>
  );
};

const MemoedVisualizationNode2D = React.memo(
  Visualization2DNode,
  (prev, next) => {
    return prev.node === next.node;
  },
);

function Visualization2DNode({
  node,
  onSelectNode,
}: {
  node: NestedNode;
  onSelectNode: OnSelectNode;
}) {
  const instance = usePlugin(plugin);

  const ref = useRef<HTMLDivElement>(null);
  let nestedChildren: NestedNode[];

  //if there is an active child don't draw the other children
  //this means we don't draw overlapping activities / tabs etc
  if (
    node.activeChildIdx != null &&
    node.activeChildIdx >= 0 &&
    node.activeChildIdx < node.children.length
  ) {
    nestedChildren = [node.children[node.activeChildIdx]];
  } else {
    nestedChildren = node.children;
  }

  const children = nestedChildren.map((child) => (
    <MemoedVisualizationNode2D
      key={child.id}
      node={child}
      onSelectNode={onSelectNode}
    />
  ));

  const isHighlighted = useValue(instance.uiState.highlightedNodes).has(
    node.id,
  );

  return (
    <div
      role="button"
      tabIndex={0}
      ref={ref}
      style={{
        position: 'absolute',
        cursor: 'pointer',
        left: toPx(node.bounds.x),
        top: toPx(node.bounds.y),
        width: toPx(node.bounds.width),
        height: toPx(node.bounds.height),
        opacity: isHighlighted ? 0.3 : 1,
        backgroundColor: isHighlighted ? 'red' : 'transparent',
      }}>
      <NodeBorder />

      {children}
    </div>
  );
}

function HoveredOverlay({
  nodeId,
  nodes,
  onSelectNode,
}: {
  nodeId: Id;
  nodes: Map<Id, ClientNode>;
  onSelectNode: OnSelectNode;
}) {
  const node = nodes.get(nodeId);

  const isVisible = useDelay(longHoverDelay);

  return (
    <Tooltip
      visible={isVisible}
      key={nodeId}
      placement="top"
      zIndex={100}
      trigger={[]}
      title={node?.name}
      align={{
        offset: [0, 7],
      }}>
      <OverlayBorder
        onClick={() => {
          onSelectNode(nodeId, 'visualiser');
        }}
        nodeId={nodeId}
        nodes={nodes}
        type="hovered"
      />
    </Tooltip>
  );
}

const OverlayBorder = styled.div<{
  type: 'selected' | 'hovered';
  nodeId: Id;
  nodes: Map<Id, ClientNode>;
}>(({type, nodeId, nodes}) => {
  const offset = getTotalOffset(nodeId, nodes);
  const node = nodes.get(nodeId);
  return {
    zIndex: 100,
    pointerEvents: type === 'selected' ? 'none' : 'auto',
    cursor: 'pointer',
    position: 'absolute',
    top: toPx(offset.y),
    left: toPx(offset.x),
    width: toPx(node?.bounds?.width ?? 0),
    height: toPx(node?.bounds?.height ?? 0),
    boxSizing: 'border-box',
    borderWidth: type === 'selected' ? 3 : 2,
    borderStyle: 'solid',
    color: 'transparent',
    borderColor:
      type === 'selected' ? theme.primaryColor : theme.textColorPlaceholder,
  };
});

/**
 * computes the x,y offset of a given node from the root of the visualization
 * in node coordinates
 */
function getTotalOffset(id: Id, nodes: Map<Id, ClientNode>): Coordinate {
  const offset = {x: 0, y: 0};
  let curId: Id | undefined = id;

  while (curId != null) {
    const cur = nodes.get(curId);
    if (cur != null) {
      offset.x += cur.bounds.x;
      offset.y += cur.bounds.y;
    }
    curId = cur?.parent;
  }

  return offset;
}

const ContextMenu: React.FC<{nodes: Map<Id, ClientNode>}> = ({children}) => {
  const instance = usePlugin(plugin);

  const focusedNodeId = useValue(instance.uiState.focusedNode);
  const hoveredNodeId = head(useValue(instance.uiState.hoveredNodes));
  const nodes = useValue(instance.nodes);
  const hoveredNode = hoveredNodeId ? nodes.get(hoveredNodeId) : null;

  return (
    <Dropdown
      onVisibleChange={(open) => {
        instance.uiActions.onContextMenuOpen(open);
      }}
      trigger={['contextMenu']}
      overlay={() => {
        return (
          <Menu>
            {hoveredNode != null && hoveredNode?.id !== focusedNodeId && (
              <UIDebuggerMenuItem
                key="focus"
                text={`Focus ${hoveredNode?.name}`}
                onClick={() => {
                  instance.uiActions.onFocusNode(hoveredNode?.id);
                }}
              />
            )}
            {focusedNodeId != null && (
              <UIDebuggerMenuItem
                key="remove-focus"
                text="Remove focus"
                onClick={() => {
                  instance.uiActions.onFocusNode(undefined);
                }}
              />
            )}
          </Menu>
        );
      }}>
      {children}
    </Dropdown>
  );
};

/**
 * this is the border that shows the green or blue line, it is implemented as a sibling to the
 * node itself so that it has the same size but the border doesnt affect the sizing of its children
 * as border is part of the box model
 */
const NodeBorder = styled.div({
  position: 'absolute',
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  boxSizing: 'border-box',
  borderWidth: '1px',
  borderStyle: 'solid',
  color: 'transparent',
  borderColor: theme.disabledColor,
});

const longHoverDelay = 500;
const pxScaleFactorCssVar = '--pxScaleFactor';
const MouseThrottle = 32;

function toPx(n: number) {
  return `calc(${n}px / var(${pxScaleFactorCssVar}))`;
}

function toNestedNode(
  rootId: Id,
  nodes: Map<Id, ClientNode>,
): NestedNode | undefined {
  function uiNodeToNestedNode(node: ClientNode): NestedNode {
    const nonNullChildren = node.children.filter(
      (childId) => nodes.get(childId) != null,
    );

    if (nonNullChildren.length !== node.children.length) {
      console.error(
        'Visualization2D.toNestedNode -> child is nullish!',
        node.children,
        nonNullChildren.map((childId) => {
          const child = nodes.get(childId);
          return child && uiNodeToNestedNode(child);
        }),
      );
    }

    const activeChildIdx = node.activeChild
      ? nonNullChildren.indexOf(node.activeChild)
      : undefined;

    return {
      id: node.id,
      name: node.name,
      attributes: node.attributes,
      children: nonNullChildren.map((childId) =>
        uiNodeToNestedNode(nodes.get(childId)!),
      ),
      bounds: node.bounds,
      tags: node.tags,
      activeChildIdx: activeChildIdx,
    };
  }

  const root = nodes.get(rootId);
  return root ? uiNodeToNestedNode(root) : undefined;
}

type FocusState = {
  actualRoot: NestedNode;
  focusedRoot: NestedNode;
  focusedRootGlobalOffset: Coordinate;
};

function caclulateFocusState(root: NestedNode, target?: Id): FocusState {
  const rootFocusState = {
    actualRoot: root,
    focusedRoot: root,
    focusedRootGlobalOffset: {x: 0, y: 0},
  };
  if (target == null) {
    return rootFocusState;
  }
  return (
    findNodeAndGlobalOffsetRec(root, {x: 0, y: 0}, root, target) ||
    rootFocusState
  );
}

function findNodeAndGlobalOffsetRec(
  node: NestedNode,
  globalOffset: Coordinate,
  root: NestedNode,
  target: Id,
): FocusState | undefined {
  const nextOffset = {
    x: globalOffset.x + node.bounds.x,
    y: globalOffset.y + node.bounds.y,
  };
  if (node.id === target) {
    //since we have already applied the this nodes offset to the root node in the visualiser we zero it out here so it isn't counted twice
    const focusedRoot = produce(node, (draft) => {
      draft.bounds.x = 0;
      draft.bounds.y = 0;
    });
    return {
      actualRoot: root,
      focusedRoot,
      focusedRootGlobalOffset: nextOffset,
    };
  }

  for (const child of node.children) {
    const offset = findNodeAndGlobalOffsetRec(child, nextOffset, root, target);
    if (offset != null) {
      return offset;
    }
  }
  return undefined;
}

function hitTest(node: NestedNode, mouseCoordinate: Coordinate): NestedNode[] {
  const res: NestedNode[] = [];

  function hitTestRec(node: NestedNode, mouseCoordinate: Coordinate): boolean {
    const nodeBounds = node.bounds;

    const thisNodeHit = boundsContainsCoordinate(nodeBounds, mouseCoordinate);

    let children = node.children;

    if (node.activeChildIdx != null) {
      children = [node.children[node.activeChildIdx]];
    }
    const offsetMouseCoord = offsetCoordinate(mouseCoordinate, nodeBounds);
    let childHit = false;

    for (const child of children) {
      childHit = hitTestRec(child, offsetMouseCoord) || childHit;
    }

    const hit = thisNodeHit && !childHit;
    if (hit) {
      res.push(node);
    }

    return hit;
  }

  hitTestRec(node, mouseCoordinate);

  return res.sort((a, b) => {
    const areaA = a.bounds.height * a.bounds.width;
    const areaB = b.bounds.height * b.bounds.width;
    if (areaA > areaB) {
      return 1;
    } else if (areaA < areaB) {
      return -1;
    } else {
      return 0;
    }
  });
}

function boundsContainsCoordinate(bounds: Bounds, coordinate: Coordinate) {
  return (
    coordinate.x >= bounds.x &&
    coordinate.x <= bounds.x + bounds.width &&
    coordinate.y >= bounds.y &&
    coordinate.y <= bounds.y + bounds.height
  );
}

function offsetCoordinate(
  coordinate: Coordinate,
  offset: Coordinate,
): Coordinate {
  return {
    x: coordinate.x - offset.x,
    y: coordinate.y - offset.y,
  };
}

function calcPxScaleFactor(snapshotBounds: Bounds, availableWidth: number) {
  return snapshotBounds.width / availableWidth;
}
