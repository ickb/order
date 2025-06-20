import { ccc } from "@ckb-ccc/core";
import { OrderData } from "./entities.js";
import type { ValueComponents } from "@ickb/utils";
/**
 * Represents a parsed order cell on the blockchain.
 *
 * Implements `ValueComponents` to expose the cell's raw data and its
 * value breakdown (CKB and UDT).
 */
export class OrderCell implements ValueComponents {
  /**
   * Creates an instance of OrderCell.
   *
   * @param cell - The raw cell fetched from the chain.
   * @param data - Decoded order data with parameters (rates, directions, etc.).
   * @param ckbUnoccupied - Amount of CKB in this cell not used in state rent.
   * @param absTotal - Absolute total value of this order (in base units).
   * @param absProgress - Absolute amount filled so far (in base units).
   * @param maturity - Estimated completion time:
   *   - `bigint` Unix timestamp in milliseconds if scheduled,
   *   - `0n` if already completed,
   *   - `undefined` if no estimate is available.
   */
  constructor(
    public cell: ccc.Cell,
    public data: OrderData,
    public ckbUnoccupied: ccc.FixedPoint,
    public absTotal: ccc.Num,
    public absProgress: ccc.Num,
    public maturity: bigint | undefined,
  ) {}

  /**
   * Gets the order CKB amount.
   *
   * @returns The CKB amount as a `ccc.FixedPoint`.
   */
  get ckbValue(): ccc.FixedPoint {
    return this.cell.cellOutput.capacity;
  }

  /**
   * Gets the order UDT amount.
   *
   * @returns The UDT amount as a `ccc.FixedPoint`.
   */
  get udtValue(): ccc.FixedPoint {
    return this.data.udtValue;
  }

  /**
   * Attempts to parse an OrderCell from a raw cell.
   *
   * Returns `undefined` if parsing or validation fails.
   *
   * @param cell - The raw chain cell to convert.
   * @returns An `OrderCell` instance or `undefined`.
   */
  static tryFrom(cell: ccc.Cell): OrderCell | undefined {
    try {
      return OrderCell.mustFrom(cell);
    } catch {
      return undefined;
    }
  }

  /**
   * Parses and validates a raw cell as OrderCell.
   *
   * Throws if the cell is invalid or data validation fails.
   *
   * @param cell - The raw chain cell to convert.
   * @returns A new `OrderCell` instance.
   * @throws When decoding or validation fails.
   */
  static mustFrom(cell: ccc.Cell): OrderCell {
    // Decode and validate the order payload
    const data = OrderData.decode(cell.outputData);
    data.validate();

    const udtValue = data.udtValue;
    const ckbUnoccupied = cell.capacityFree;
    const { ckbToUdt, udtToCkb } = data.info;
    const isCkb2Udt = data.info.isCkb2Udt();
    const isUdt2Ckb = data.info.isUdt2Ckb();
    const isDualRatio = isCkb2Udt && isUdt2Ckb;

    // Compute total values in base units
    const ckb2UdtValue = isCkb2Udt
      ? ckbUnoccupied * ckbToUdt.ckbScale + udtValue * ckbToUdt.udtScale
      : 0n;
    const udt2CkbValue = isUdt2Ckb
      ? ckbUnoccupied * udtToCkb.ckbScale + udtValue * udtToCkb.udtScale
      : 0n;

    // Determine absolute total: single or average for dual-ratio
    const absTotal =
      ckb2UdtValue === 0n
        ? udt2CkbValue
        : udt2CkbValue === 0n
          ? ckb2UdtValue
          : // Take the average of the two values for dual ratio orders
            (ckb2UdtValue * udtToCkb.ckbScale * udtToCkb.udtScale +
              udt2CkbValue * ckbToUdt.ckbScale * ckbToUdt.udtScale) >>
            1n;

    // Compute progress: full for dual, else based on direction
    const absProgress = isDualRatio
      ? absTotal
      : isCkb2Udt
        ? udtValue * ckbToUdt.udtScale
        : ckbUnoccupied * udtToCkb.ckbScale;

    // Maturity: undefined if in-progress or dual; zero if complete
    const maturity = isDualRatio || absTotal !== absProgress ? undefined : 0n;

    return new OrderCell(
      cell,
      data,
      ckbUnoccupied,
      absTotal,
      absProgress,
      maturity,
    );
  }

  /**
   * Checks if the order is is dual ratio.
   *
   * @returns True if the order is dual ratio (liquidity provider), otherwise false.
   */
  isDualRatio(): boolean {
    return this.data.info.isDualRatio();
  }

  /**
   * Checks if the order can be matched as a CKB to UDT order.
   * @returns True if the order is matchable as CKB to UDT, otherwise false.
   */
  isCkb2UdtMatchable(): boolean {
    return this.data.info.isCkb2Udt() && this.ckbUnoccupied > 0n;
  }

  /**
   * Checks if the order can be matched as a UDT to CKB order.
   * @returns True if the order is matchable as UDT to CKB, otherwise false.
   */
  isUdt2CkbMatchable(): boolean {
    return this.data.info.isUdt2Ckb() && this.data.udtValue > 0n;
  }

  /**
   * Checks if the order is matchable in any way.
   * @returns True if the order is matchable, otherwise false.
   */
  isMatchable(): boolean {
    return this.isCkb2UdtMatchable() || this.isUdt2CkbMatchable();
  }

  /**
   * Checks if the order is fulfilled.
   *
   * @returns True if the order is fulfilled (not matchable), otherwise false.
   */
  isFulfilled(): boolean {
    return !this.isMatchable();
  }

  /**
   * Retrieves the master out point of the order.
   * @returns The master out point associated with the order.
   */
  getMaster(): ccc.OutPoint {
    return this.data.getMaster(this.cell.outPoint);
  }

  /**
   * Countermeasure to Confusion Attack https://github.com/ickb/whitepaper/issues/19
   * Validates the order against a descendant order.
   * @param descendant - The descendant order to validate against.
   * @throws Will throw an error if validation fails.
   */
  validate(descendant: OrderCell): void {
    // Same cell, nothing to check
    if (this.cell.outPoint.eq(descendant.cell.outPoint)) {
      return;
    }

    if (!this.cell.cellOutput.lock.eq(descendant.cell.cellOutput.lock)) {
      throw Error("Order script different");
    }

    const udt = this.cell.cellOutput.type;
    if (!udt || !descendant.cell.cellOutput.type?.eq(udt)) {
      throw Error("UDT type is different");
    }

    if (!descendant.getMaster().eq(this.getMaster())) {
      throw Error("Master is different");
    }

    if (!this.data.info.eq(this.data.info)) {
      throw Error("Info is different");
    }

    if (this.absTotal > descendant.absTotal) {
      throw Error("Total value is lower than the original one");
    }

    if (this.absProgress > descendant.absProgress) {
      throw Error("Progress is lower than the original one");
    }
  }

  /**
   * Checks if the descendant order is valid against this order.
   * @param descendant - The descendant order to validate.
   * @returns True if the descendant is valid, otherwise false.
   */
  isValid(descendant: OrderCell): boolean {
    try {
      this.validate(descendant);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Countermeasure to Confusion Attack https://github.com/ickb/whitepaper/issues/19
   * Resolves the best descendant order from a list of descendants.
   * @param descendants - The list of descendant orders to resolve.
   * @returns The best matching descendant order or undefined if none is valid.
   */
  resolve(descendants: OrderCell[]): OrderCell | undefined {
    let best: OrderCell | undefined = undefined;
    for (const descendant of descendants) {
      if (!this.isValid(descendant)) {
        continue;
      }

      // Pick order with best absProgress. At equality of absProgress, give preference to newly minted orders
      if (
        !best ||
        best.absProgress < descendant.absProgress ||
        (best.absProgress === descendant.absProgress && !best.data.isMint())
      ) {
        best = descendant;
      }
    }

    return best;
  }
}

/**
 * Represents a master cell
 */
export class MasterCell implements ValueComponents {
  /**
   * Creates an instance of MasterCell.
   * @param cell - The ccc.Cell instance to be wrapped by the MasterCell.
   */
  constructor(public cell: ccc.Cell) {}

  /**
   * Creates a MasterCell instance from a cell-like object.
   * @param cellLike - An object that can be converted to a ccc.Cell.
   * @returns A new instance of MasterCell.
   */
  static from(cellLike: ccc.CellLike): MasterCell {
    return new MasterCell(ccc.Cell.from(cellLike));
  }

  /**
   * Validates the MasterCell against an OrderCell.
   * @param order - The OrderCell to validate against.
   * @throws Error if the order script is different or if the master is different.
   */
  validate(order: OrderCell): void {
    if (!this.cell.cellOutput.type?.eq(order.cell.cellOutput.lock)) {
      throw Error("Order script different");
    }

    if (!order.getMaster().eq(this.cell.outPoint)) {
      throw Error("Master is different");
    }
  }

  /**
   * Gets the CKB value of the cell.
   *
   * @returns The total CKB amount as a `ccc.FixedPoint`.
   */
  get ckbValue(): ccc.FixedPoint {
    return this.cell.cellOutput.capacity;
  }

  /**
   * Gets the UDT value of the cell.
   *
   * For a Master Cell, the UDT amount is always zero.
   *
   * @returns The UDT amount as a `ccc.FixedPoint` (0n).
   */
  readonly udtValue = 0n;
}

/**
 * Represents a group of orders associated with a master cell.
 */
export class OrderGroup implements ValueComponents {
  /**
   * Creates an instance of OrderGroup.
   * @param master - The master cell associated with the order group.
   * @param order - The order within the group.
   * @param origin - The original order associated with the group.
   */
  constructor(
    public master: MasterCell,
    public order: OrderCell,
    public origin: OrderCell,
  ) {}

  /**
   * Tries to create an OrderGroup from the provided parameters.
   * @param master - The master cell.
   * @param order - The order within the group.
   * @param origin - The original order.
   * @returns An OrderGroup instance or undefined if creation fails.
   */
  static tryFrom(
    master: MasterCell,
    order: OrderCell,
    origin: OrderCell,
  ): OrderGroup | undefined {
    const og = new OrderGroup(master, order, origin);
    if (og.isValid()) {
      return og;
    }
    return undefined;
  }

  /**
   * Validates the order group against its master and origin orders.
   * @throws Will throw an error if validation fails.
   */
  validate(): void {
    this.master.validate(this.order);
    this.origin.validate(this.order);
  }

  /**
   * Checks if the order group is valid.
   * @returns True if the order group is valid, otherwise false.
   */
  isValid(): boolean {
    try {
      this.validate();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if the specified lock is the owner of the master cell.
   *
   * @param locks - The locks to check ownership against.
   * @returns True if the lock is the owner, otherwise false.
   */
  isOwner(...locks: ccc.Script[]): boolean {
    const lock = this.master.cell.cellOutput.lock;
    return locks.some((l) => lock.eq(l));
  }

  /**
   * Gets the CKB value of the group.
   *
   * @returns The total CKB amount as a `ccc.FixedPoint`, which is the sum of the CKB values of the order cell and the master cell.
   */
  get ckbValue(): ccc.FixedPoint {
    return (
      this.order.cell.cellOutput.capacity + this.master.cell.cellOutput.capacity
    );
  }

  /**
   * Gets the UDT value of the group.
   *
   * @returns The UDT amount as a `ccc.FixedPoint`, derived from the order cell.
   */
  get udtValue(): ccc.FixedPoint {
    return this.order.data.udtValue;
  }
}
