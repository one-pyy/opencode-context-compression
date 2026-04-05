export interface CoverageRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface CoverageTreeNode<T extends CoverageRange> extends CoverageRange {
  readonly value: T;
  readonly children: CoverageTreeNode<T>[];
}

export interface CoverageTreeRoot<T extends CoverageRange> {
  readonly children: CoverageTreeNode<T>[];
}

export interface CoverageTreeInsertResult<T extends CoverageRange> {
  readonly accepted: boolean;
  readonly node?: CoverageTreeNode<T>;
  readonly error?: {
    readonly code: "intersects-without-containment";
    readonly conflictingNode: CoverageTreeNode<T>;
  };
}

type RangeRelation =
  | "disjoint"
  | "equal"
  | "contains"
  | "within"
  | "intersects";

export function createCoverageTreeRoot<T extends CoverageRange>(): CoverageTreeRoot<T> {
  return { children: [] };
}

export function insertIntoCoverageTree<T extends CoverageRange>(
  root: CoverageTreeRoot<T>,
  value: T,
): CoverageTreeInsertResult<T> {
  const node = createNode(value);
  return insertIntoParent(root, node);
}

function insertIntoParent<T extends CoverageRange>(
  parent: CoverageTreeRoot<T> | CoverageTreeNode<T>,
  node: CoverageTreeNode<T>,
): CoverageTreeInsertResult<T> {
  const overlaps = parent.children.filter(
    (child) => compareCoverageRanges(node, child) !== "disjoint",
  );
  const conflictingNode = overlaps.find(
    (child) => compareCoverageRanges(node, child) === "intersects",
  );
  if (conflictingNode !== undefined) {
    return {
      accepted: false,
      error: {
        code: "intersects-without-containment",
        conflictingNode,
      },
    };
  }

  const container = overlaps.find(
    (child) => compareCoverageRanges(node, child) === "within",
  );
  if (container !== undefined) {
    return insertIntoParent(container, node);
  }

  const adoptedChildren = overlaps.filter((child) => {
    const relation = compareCoverageRanges(node, child);
    return relation === "contains" || relation === "equal";
  });

  if (adoptedChildren.length > 0) {
    parent.children.splice(0, parent.children.length, ...parent.children.filter(
      (child) => !adoptedChildren.includes(child),
    ));
    node.children.push(...sortNodes(adoptedChildren));
  }

  parent.children.push(node);
  parent.children.splice(0, parent.children.length, ...sortNodes(parent.children));

  return {
    accepted: true,
    node,
  };
}

function createNode<T extends CoverageRange>(value: T): CoverageTreeNode<T> {
  return {
    value,
    startIndex: value.startIndex,
    endIndex: value.endIndex,
    children: [],
  };
}

function sortNodes<T extends CoverageRange>(
  nodes: readonly CoverageTreeNode<T>[],
): CoverageTreeNode<T>[] {
  return [...nodes].sort(
    (left, right) =>
      left.startIndex - right.startIndex || left.endIndex - right.endIndex,
  );
}

function compareCoverageRanges(
  left: CoverageRange,
  right: CoverageRange,
): RangeRelation {
  if (left.endIndex < right.startIndex || right.endIndex < left.startIndex) {
    return "disjoint";
  }

  const leftContainsRight =
    left.startIndex <= right.startIndex && left.endIndex >= right.endIndex;
  const rightContainsLeft =
    right.startIndex <= left.startIndex && right.endIndex >= left.endIndex;

  if (leftContainsRight && rightContainsLeft) {
    return "equal";
  }

  if (leftContainsRight) {
    return "contains";
  }

  if (rightContainsLeft) {
    return "within";
  }

  return "intersects";
}
