import { ccc } from "@ckb-ccc/core";
import {
  BufferedGenerator,
  defaultFindCellsLimit,
  hexFrom,
  type ExchangeRatio,
  type ScriptDeps,
  type SmartTransaction,
  type UdtHandler,
  type ValueComponents,
} from "@ickb/utils";
import { Info, OrderData, Ratio, Relative, type InfoLike } from "./entities.js";
import { MasterCell, OrderCell, OrderGroup } from "./cells.js";

/**
 * Utilities for managing UDT orders on Nervos L1 such as minting, matching, and melting.
 */
export class OrderManager implements ScriptDeps {
  /**
   * Creates an instance of OrderManager.
   *
   * @param script - The order script.
   * @param cellDeps - The cell dependencies for the order.
   * @param udtHandler - The handler for UDT (User Defined Token).
   */
  constructor(
    public readonly script: ccc.Script,
    public readonly cellDeps: ccc.CellDep[],
    public readonly udtHandler: UdtHandler,
  ) {}

  /**
   * Checks if the given cell is an order.
   *
   * A cell is considered an order if its lock script matches the order script of the manager and its type script
   * equates to the UDT handler's script.
   *
   * @param cell - The cell to check.
   * @returns True if the cell is an order; otherwise, false.
   */
  isOrder(cell: ccc.Cell): boolean {
    return (
      cell.cellOutput.lock.eq(this.script) &&
      Boolean(cell.cellOutput.type?.eq(this.udtHandler.script))
    );
  }

  /**
   * Checks if the given cell is a master cell.
   *
   * A cell is recognized as a master cell if its type script matches the order script.
   *
   * @param cell - The cell to check.
   * @returns True if the cell is a master cell; otherwise, false.
   */
  isMaster(cell: ccc.Cell): boolean {
    return Boolean(cell.cellOutput.type?.eq(this.script));
  }

  /**
   * Previews the conversion between CKB and UDT.
   *
   * This method calculates a conversion preview using an exchange ratio midpoint.
   *
   * Optionally, a fee may be applied that influences the effective conversion rate,
   * resulting in additional fees or gains. The fee is applied by adjusting the ratio using the
   * provided fee and feeBase. In practice, the fee is incorporated by multiplying the numerator by
   * (feeBase - fee) and the denominator by feeBase.
   *
   * Effectively the computed fee scales the converted amount by (feeBase - fee) / feeBase, for example:
   * -  (100000 - 1000) / 100000 = 0.99 (1% fee).
   * -  (100000 - 300) / 100000 = 0.997 (0.3% fee).
   * -  (100000 - 1) / 100000 = 0.99999 (0.001% fee).
   *
   * This computation ensures that the fee is applied as a fixed percentage using the same
   * integer arithmetic as the midpoint conversion ratio, with control over rounding adjustments.
   *
   * @param isCkb2Udt - Indicates if the conversion is from CKB to UDT:
   *                    - If true, converts CKB to UDT.
   *                    - Otherwise, converts UDT to CKB.
   * @param midpoint - The exchange ratio used as the midpoint for conversion.
   *                   It should contain both CKB and UDT scaling factors.
   * @param amounts - An object of ValueComponents containing the CKB and UDT amounts.
   * @param options - Optional conversion parameters.
   * @param options.fee - The fee (as a ccc.Num) to apply during conversion. It represents the fee portion
   *                      in integer terms (e.g., fee basis-points) and defaults to 0n (i.e., no fee).
   *                      Internally, the fee is applied as a scaling factor: (feeBase – fee) / feeBase.
   * @param options.feeBase - The base reference (as a ccc.Num) used for fee calculation.
   *                          Defaults to 100000n if not provided. The feeBase defines the scaling factor
   *                          in which fee is applied, ensuring fee is always a fixed percentage.
   * @param options.ckbMinMatchLog - Optional minimum logarithmic matching threshold for CKB.
   *                                 This is used for further internal validation or matching criteria.
   *                                 Defaults to 33 (~86 CKB) if not provided.
   *
   * @returns An object with the following properties:
   * - convertedAmount: The converted amount as a ccc.FixedPoint in the target unit.
   * - ckbFee: The fee (or gain) in CKB, computed as a ccc.FixedPoint.
   * - info: Additional conversion information as Info, to be used in OrderManager.mint.
   *
   * @example
   * // Example usage previewing the conversion from CKB to iCKB UDT:
   * const result = OrderManager.convert(
   *   true, // CKB to UDT
   *   ickbExchangeRatio(tipHeader),
   *   {
   *     ckbValue: ccc.FixedPointFrom("1000"), // 1000 CKB
   *     udtValue: 0n,
   *   },
   *   {
   *     feeBase: 100000n,
   *     fee: 1n, // (100000 - 1) / 100000 = 0.99999 (i.e., a 0.001% fee is deducted).
   *     ckbMinMatchLog: 33
   *   }
   * );
   */
  static convert(
    isCkb2Udt: boolean,
    midpoint: ExchangeRatio,
    amounts: ValueComponents,
    options?: {
      fee?: ccc.Num;
      feeBase?: ccc.Num;
      ckbMinMatchLog?: number;
    },
  ): { convertedAmount: ccc.FixedPoint; ckbFee: ccc.FixedPoint; info: Info } {
    // Set fee and feeBase with fallback default values.
    const fee = options?.fee ?? 0n;
    const feeBase = options?.feeBase ?? 100000n;

    // Create a Ratio instance from the midpoint ratio.
    const base = Ratio.from(midpoint);

    // Apply the fee adjustment to the ratio.
    const adjusted = base.applyFee(isCkb2Udt, fee, feeBase);

    // Select the input amount based on the conversion direction.
    const amount = isCkb2Udt ? amounts.ckbValue : amounts.udtValue;

    // Perform the conversion using the adjusted ratio.
    const convertedAmount = adjusted.convert(isCkb2Udt, amount, true);
    let ckbFee = 0n;

    // Calculate fee (or gain) based on the original midpoint rate.
    if (amount > 0n && fee !== 0n) {
      ckbFee = isCkb2Udt
        ? amount - base.convert(false, convertedAmount, false)
        : base.convert(true, amount, false) - convertedAmount;
    }

    // Generate additional conversion info for further processing.
    const info = Info.create(isCkb2Udt, adjusted, options?.ckbMinMatchLog);

    return { convertedAmount, ckbFee, info };
  }

  /**
   * Mints a new order cell and appends it to the transaction.
   *
   * The method performs the following:
   * - Creates order data using the provided amounts and order information.
   * - Adds required cell dependencies and UDT handlers to the transaction.
   * - Appends the order cell to the outputs with the UDT data and adjusts the CKB capacity.
   * - Appends a corresponding master cell immediately after the order cell.
   *
   * @param tx - The transaction to which the order will be added.
   * @param lock - The lock script for the master cell.
   * @param info - The information related to the order, usually calculated using OrderManager.convert.
   * @param amounts - The amounts for the order, including:
   *    @param amounts.ckbValue - The amount of CKB to allocate for the order (note: more CKB than expressed might be used).
   *    @param amounts.udtValue - The amount of UDT to allocate for the order.
   *
   * @returns void
   */
  mint(
    tx: SmartTransaction,
    lock: ccc.Script,
    info: InfoLike,
    amounts: ValueComponents,
  ): void {
    const { ckbValue, udtValue } = amounts;
    const data = OrderData.from({
      udtValue,
      master: {
        type: "relative",
        value: Relative.create(1n), // master is appended right after its order
      },
      info,
    });

    tx.addCellDeps(this.cellDeps);
    tx.addUdtHandlers(this.udtHandler);

    // Append order cell to Outputs
    const position = tx.addOutput(
      {
        lock: this.script,
        type: this.udtHandler.script,
      },
      data.toBytes(),
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    tx.outputs[position]!.capacity += ckbValue;

    // Append master cell to Outputs right after its order
    tx.addOutput({
      lock,
      type: this.script,
    });
  }

  /**
   * Adds the match to the Transaction.
   *
   * Iterates over the partial matches (if any) and for each:
   * - Adds the original order as an input.
   * - Creates an updated output with adjusted CKB capacity and UDT data.
   *
   * @param tx - The transaction to which the matches will be added.
   * @param match - The match object containing partial matches.
   */
  addMatch(tx: SmartTransaction, match: Match): void {
    const partials = match.partials;
    if (partials.length === 0) {
      return;
    }

    tx.addCellDeps(this.cellDeps);
    tx.addUdtHandlers(this.udtHandler);

    for (const { order, ckbOut, udtOut } of partials) {
      tx.addInput(order.cell);
      tx.addOutput(
        {
          lock: this.script,
          type: this.udtHandler.script,
          capacity: ckbOut,
        },
        OrderData.from({
          udtValue: udtOut,
          master: {
            type: "absolute",
            value: order.getMaster(),
          },
          info: order.data.info,
        }).toBytes(),
      );
    }
  }

  /**
   * Matches the order with the specified parameters.
   *
   * Uses an OrderMatcher (if available) to compute the match based on a provided allowance.
   * If no matcher is available, returns a match with zero deltas and no partials.
   *
   * @param order - The order cell to match against.
   * @param isCkb2Udt - If true the match is in the CKB-to-UDT direction; otherwise UDT-to-CKB.
   * @param allowance - The matching allowance as a fixed point number.
   *
   * @throws Will throw an error if the order is incompatible.
   *
   * @returns A Match object containing:
   *    • ckbDelta: net change in CKB value,
   *    • udtDelta: net change in UDT value,
   *    • partials: a list of partial matches.
   */
  match(
    order: OrderCell,
    isCkb2Udt: boolean,
    allowance: ccc.FixedPoint,
  ): Match {
    return (
      OrderMatcher.from(order, isCkb2Udt, 0n)?.match(allowance) ?? {
        ckbDelta: 0n,
        udtDelta: 0n,
        partials: [],
      }
    );
  }

  /**
   * Finds the best match for a given set of orders based on the current exchange rate.
   *
   * Evaluates pairs of matches (CKB-to-UDT and UDT-to-CKB) to determine the optimal combined match.
   * The best match is chosen based on remaining allowances and overall gain.
   *
   * @param orderPool - The list of order cells to consider for matching.
   * @param allowance - The allowance for CKB and UDT as a ValueComponents object.
   * @param exchangeRate - The current exchange rate between CKB and UDT, including scaling factors.
   * @param options - Optional parameters for matching:
   *    @param options.feeRate - Fee rate for the transaction (defaults to 1000n if not provided).
   *    @param options.ckbAllowanceStep - The step value for CKB allowance (defaults to 1000 CKB as fixed point).
   *
   * @returns A Match object containing the best combination of:
   *    • ckbDelta: net change in CKB,
   *    • udtDelta: net change in UDT,
   *    • partials: list of partial matches.
   */
  static bestMatch(
    orderPool: OrderCell[],
    allowance: ValueComponents,
    exchangeRate: ExchangeRatio,
    options?: {
      feeRate?: ccc.Num; // Fee rate for the transaction
      ckbAllowanceStep?: ccc.FixedPoint;
    },
  ): Match {
    const orderSize = orderPool[0]?.cell.occupiedSize ?? 0;
    if (!orderSize) {
      return {
        ckbDelta: 0n,
        udtDelta: 0n,
        partials: [],
      };
    }

    const { ckbScale, udtScale } = exchangeRate;
    // Get fee rate or base fee rate if not provided
    const feeRate = options?.feeRate ?? 1000n;
    const ckbMiningFee = (ccc.numFrom(36 + orderSize) * feeRate + 999n) / 1000n;

    // ckbAllowanceStep should be 1000 CKB if not provided
    const ckbAllowanceStep =
      options?.ckbAllowanceStep ?? ccc.fixedPointFrom("1000");
    const udtAllowanceStep =
      (ckbAllowanceStep * ckbScale + udtScale - 1n) / udtScale;

    const ckb2UdtMatches = new BufferedGenerator(
      OrderManager.sequentialMatcher(
        orderPool,
        true,
        ckbAllowanceStep,
        ckbMiningFee,
      ),
      2,
    );
    const udt2CkbMatches = new BufferedGenerator(
      OrderManager.sequentialMatcher(
        orderPool,
        false,
        udtAllowanceStep,
        ckbMiningFee,
      ),
      2,
    );

    let best = {
      i: -1,
      j: -1,
      ckbDelta: 0n,
      udtDelta: 0n,
      partials: [] as Match["partials"],
      ckbAllowance: allowance.ckbValue,
      udtAllowance: allowance.udtValue,
      gain: -1n << 256n,
    };
    while (best.i !== 0 && best.j !== 0) {
      ckb2UdtMatches.next(best.i);
      udt2CkbMatches.next(best.j);
      best.i = 0;
      best.j = 0;

      for (const [i, c2u] of ckb2UdtMatches.buffer.entries()) {
        for (const [j, u2c] of udt2CkbMatches.buffer.entries()) {
          const ckbDelta = c2u.ckbDelta + u2c.ckbDelta;
          const udtDelta = c2u.udtDelta + u2c.udtDelta;
          const partials = c2u.partials.concat(u2c.partials);
          const ckbFee = ckbMiningFee * ccc.fixedPointFrom(partials.length);
          const ckbAllowance = allowance.ckbValue + ckbDelta - ckbFee;
          const udtAllowance = allowance.udtValue + udtDelta;
          const gain = ckbDelta * ckbScale + udtDelta * udtScale;

          if (ckbAllowance >= 0n && udtAllowance >= 0n && gain > best.gain) {
            best = {
              i,
              j,
              ckbDelta,
              udtDelta,
              partials,
              ckbAllowance,
              udtAllowance,
              gain,
            };
          }
        }
      }
    }

    const { ckbDelta, udtDelta, partials } = best;
    return {
      ckbDelta,
      udtDelta,
      partials,
    };
  }

  /**
   * Returns a generator that sequentially yields match objects for a given order pool.
   *
   * For each order, it uses an OrderMatcher (if available) to compute a match for increasing allowances,
   * and yields the cumulative matched result.
   *
   * The matching for each order is performed in a sequential manner:
   *  1. An array of matchers is created from the order pool, filtering out any undefined ones and sorting
   *     them in decreasing order by real match ratio (best gain per unit first).
   *  2. A cumulative empty Match object is initialized and immediately yielded as the first match.
   *  3. For each matcher, the algorithm performs a fair distribution of the matcher's `bMaxMatch` into
   *     partial matches. The distribution follows these rules:
   *       - Each partial match has at least N elements (where N is determined by dividing bMaxMatch by allowanceStep).
   *       - The number of partial matches is maximized.
   *       - The distribution is as fair as possible (i.e., partial match sizes differ by at most one sats).
   *  4. The algorithm yields the cumulative match after processing each partial match; if a certain allowance is too low
   *     and does not produce any partial matches, the matcher is skipped.
   *
   * @param orderPool - The list of order cells to match.
   * @param isCkb2Udt - A flag indicating the matching direction. If true, matching is done from CKB to UDT; otherwise, from UDT to CKB.
   * @param allowanceStep - The step increment for the allowance represented as a fixed point number.
   * @param ckbMiningFee - The CKB mining fee represented as a fixed point value.
   *
   * @yields A Match object representing the cumulative match up to the current matcher.
   */
  static *sequentialMatcher(
    orderPool: OrderCell[],
    isCkb2Udt: boolean,
    allowanceStep: ccc.FixedPoint,
    ckbMiningFee: ccc.FixedPoint,
  ): Generator<Match, void, void> {
    // Generate matchers from the given order pool using OrderMatcher, filter out undefined results,
    // and sort the matchers by their real match ratio in decreasing order.
    const matchers = orderPool
      .map((o) => OrderMatcher.from(o, isCkb2Udt, ckbMiningFee))
      .filter((m) => m !== undefined)
      .sort((a, b) => b.realRatio - a.realRatio);

    // Initialize an accumulator for the cumulative match.
    let acc: Match = {
      ckbDelta: 0n,
      udtDelta: 0n,
      partials: [],
    };

    let curr = acc;
    yield curr;

    // Process each matcher in sequence.
    loop: for (const matcher of matchers) {
      const maxMatch = matcher.bMaxMatch;
      // Distribute maxMatch into partial matches according to a fair distribution policy:
      //  - Each partial match is of at least of allowanceStep size.
      //  - The number of partial matches is maximized.
      //  - The distribution is as fair as possible (i.e., partial match sizes differ by at most 1 sats).
      //
      // Here, N is defined as ceil(maxMatch / allowanceStep).
      const N = (maxMatch + allowanceStep - 1n) / allowanceStep;

      // Determine the base quota (q) and remainder (r) for fair distribution.
      // q = base units per partial match.
      // r = the number of partial matches that will receive one extra unit.
      const q = maxMatch / N;
      const r = maxMatch % N;

      let allowance = 0n;
      for (let i = 0n; i < N; i++) {
        // For the first r partial matches, assign an extra unit (q + 1); for the rest, assign q.
        allowance += i < r ? q + 1n : q;

        // Compute the match using the current allowance.
        const m = matcher.match(allowance);
        // If the current allowance is too low to yield any partial matches,
        // skip to the next matcher.
        if (m.partials.length === 0) {
          continue loop;
        }
        // Update the cumulative match by aggregating the deltas and partials.
        curr = {
          ckbDelta: acc.ckbDelta + m.ckbDelta,
          udtDelta: acc.udtDelta + m.udtDelta,
          partials: acc.partials.concat(m.partials),
        };
        // Yield the newly updated cumulative match.
        yield curr;
      }
      // Update the accumulator with the current cumulative match for the next matcher.
      acc = curr;
    }
  }

  /**
   * Melts the specified order groups.
   *
   * For each order group, if the option is to only process fulfilled orders, it filters accordingly.
   * Then, for every valid group, the master and order cells are added as inputs in the transaction.
   *
   * @param tx - The transaction to which the groups will be added.
   * @param groups - The array of OrderGroup instances to melt.
   * @param options - Optional parameters:
   *    @param options.isFulfilledOnly - If true, only groups with fulfilled orders will be melted.
   *
   * @returns void
   */
  melt(
    tx: SmartTransaction,
    groups: OrderGroup[],
    options?: {
      isFulfilledOnly?: boolean;
    },
  ): void {
    const isFulfilledOnly = options?.isFulfilledOnly ?? false;
    if (isFulfilledOnly) {
      groups = groups.filter((g) => g.order.isFulfilled());
    }
    if (groups.length === 0) {
      return;
    }
    tx.addCellDeps(this.cellDeps);
    tx.addUdtHandlers(this.udtHandler);

    for (const group of groups) {
      tx.addInput(group.order.cell);
      tx.addInput(group.master.cell);
    }
  }

  /**
   * Finds orders associated with this OrderManager instance.
   *
   * This async generator performs:
   *   1. Fetch simple orders (lock-script cells matching order & UDT handler).
   *   2. Fetch master cells (type-script cells matching order).
   *   3. Group each simple order under its master cell; initiate origin lookup once.
   *   4. For each group with orders and a resolved origin:
   *      - Resolve the best order via `origin.resolve(orders)`.
   *      - Construct an `OrderGroup` via `OrderGroup.tryFrom(...)`.
   *      - Yield the valid `OrderGroup`.
   *
   * @param client – Client to interact with the blockchain.
   * @param options.limit – Maximum cells to scan per findCells batch. Defaults to `defaultFindCellsLimit` (400).
   * @yields OrderGroup instances combining master, order, and origin cells.
   */
  async *findOrders(
    client: ccc.Client,
    options?: { limit?: number },
  ): AsyncGenerator<OrderGroup> {
    const limit = options?.limit ?? defaultFindCellsLimit;

    // Fetch simple orders & master cells in parallel
    const [simpleOrders, allMasters] = await Promise.all([
      this.findSimpleOrders(client, limit),
      this.findAllMasters(client, limit),
    ]);

    // Prepare a map of masterCellKey → { master, originPromise?, orders[] }
    const rawGroups = new Map(
      allMasters.map((master) => [
        hexFrom(master.cell.outPoint),
        {
          master,
          origin: undefined as Promise<OrderCell | undefined> | undefined,
          orders: [] as OrderCell[],
        },
      ]),
    );

    // Group simple orders by their master cell, kick off origin lookup once per master
    for (const order of simpleOrders) {
      const master = order.getMaster();
      const key = hexFrom(master);
      const rawGroup = rawGroups.get(key);

      if (!rawGroup) {
        // No matching master cell found
        continue;
      }

      rawGroup.orders.push(order);

      // Only initialize origin lookup once
      rawGroup.origin ??= this.findOrigin(client, master);
    }

    // For each populated group, await origin, resolve the best order, and yield OrderGroup
    for (const {
      master,
      origin: originPromise,
      orders,
    } of rawGroups.values()) {
      if (orders.length === 0 || !originPromise) {
        continue;
      }

      const origin = await originPromise;
      if (!origin) {
        continue;
      }

      const order = origin.resolve(orders);
      if (!order) {
        continue;
      }

      const orderGroup = OrderGroup.tryFrom(master, order, origin);
      if (!orderGroup) {
        continue;
      }

      yield orderGroup;
    }
  }

  /**
   * Finds simple orders on the blockchain.
   *
   * Queries cells whose lock script equals the order script and whose type script
   * matches the UDT handler's script, returning only valid {@link OrderCell} instances.
   *
   * @param client – The client used to interact with the blockchain.
   * @param limit – Maximum cells to scan per findCells batch.
   * @returns Promise that resolves to an array of {@link OrderCell}.
   */
  private async findSimpleOrders(
    client: ccc.Client,
    limit: number,
  ): Promise<OrderCell[]> {
    const orders: OrderCell[] = [];

    for await (const cell of client.findCellsOnChain(
      {
        script: this.script,
        scriptType: "lock",
        filter: {
          script: this.udtHandler.script,
        },
        scriptSearchMode: "exact",
        withData: true,
      },
      "asc",
      limit,
    )) {
      const order = OrderCell.tryFrom(cell);
      if (!order || !this.isOrder(cell)) {
        // Skip non-order cells or failed conversions
        continue;
      }
      orders.push(order);
    }

    return orders;
  }

  /**
   * Finds all master cells on the blockchain.
   *
   * Searches for cells whose type script exactly matches the order script,
   * then wraps them as {@link MasterCell} instances.
   *
   * @param client – The client used to interact with the blockchain.
   * @param limit – Maximum cells to scan per findCells batch.
   * @returns Promise that resolves to an array of {@link MasterCell}.
   */
  private async findAllMasters(
    client: ccc.Client,
    limit: number,
  ): Promise<MasterCell[]> {
    const masters: MasterCell[] = [];

    for await (const cell of client.findCellsOnChain(
      {
        script: this.script,
        scriptType: "type",
        scriptSearchMode: "exact",
        withData: true,
      },
      "asc",
      limit,
    )) {
      if (!this.isMaster(cell)) {
        // Skip cells that do not satisfy master criteria
        continue;
      }
      masters.push(new MasterCell(cell));
    }

    return masters;
  }

  /**
   * Finds the origin order associated with a given master out point.
   *
   * Starting from the master cell's index, the method searches backwards first for an order matching the master.
   * If not found, it searches forwards until an order is found or there is no more cell.
   *
   * @param client - The client used to interact with the blockchain.
   * @param master - The master out point to find the origin for.
   *
   * @returns A promise that resolves to the originating OrderCell or undefined if not found.
   */
  private async findOrigin(
    client: ccc.Client,
    master: ccc.OutPoint,
  ): Promise<OrderCell | undefined> {
    const { txHash, index: mIndex } = master;
    for (let index = mIndex - 1n; index >= 0n; index--) {
      const cell = await client.getCell({ txHash, index });
      if (!cell) {
        return;
      }

      const order = OrderCell.tryFrom(cell);
      if (order?.getMaster().eq(master)) {
        return order;
      }
    }

    // eslint-disable-next-line no-constant-condition, @typescript-eslint/no-unnecessary-condition
    for (let index = mIndex + 1n; true; index++) {
      const cell = await client.getCell({ txHash, index });
      if (!cell) {
        return;
      }

      const order = OrderCell.tryFrom(cell);
      if (order?.getMaster().eq(master)) {
        return order;
      }
    }
  }
}

/**
 * Represents a partial match result for an order.
 */
export interface Match {
  /**
   * The change in CKB for the matches from the matcher perspective.
   */
  ckbDelta: bigint;

  /**
   * The change in UDT for the matches from the matcher perspective.
   */
  udtDelta: bigint;

  /**
   * An array of match details.
   *
   * Each match includes the order cell involved in the match,
   * the output amount of CKB, and the output amount of UDT.
   */
  partials: {
    /**
     * The order cell involved in the match.
     */
    order: OrderCell;

    /**
     * The output amount of CKB.
     */
    ckbOut: ccc.FixedPoint;

    /**
     * The output amount of UDT.
     */
    udtOut: ccc.FixedPoint;
  }[];
}

/**
 * OrderMatcher is responsible for computing match results for an order.
 *
 * It encapsulates all parameters and logic required to match an order based on a given allowance.
 */
export class OrderMatcher {
  /**
   * @param order - The order cell to match.
   * @param isCkb2Udt - Indicates whether the matching direction is from CKB to UDT (true) or vice versa.
   * @param aScale - Scaling factor for the primary asset (CKB when isCkb2Udt is true, otherwise UDT).
   * @param bScale - Scaling factor for the secondary asset (UDT when isCkb2Udt is true, otherwise CKB).
   * @param aIn - The input amount for asset A.
   * @param bIn - The input amount for asset B.
   * @param aMin - The minimum allowable output for asset A (e.g., minimum CKB after fee deduction).
   * @param bMinMatch - The minimum matching amount for asset B.
   * @param bMaxMatch - The maximum amount of asset B that can be matched.
   * @param bMaxOut - The maximum output amount for asset B.
   * @param realRatio - The actual exchange ratio computed based on the available amounts.
   */
  constructor(
    public readonly order: OrderCell,
    public readonly isCkb2Udt: boolean,
    public readonly aScale: ccc.Num,
    public readonly bScale: ccc.Num,
    public readonly aIn: ccc.FixedPoint,
    public readonly bIn: ccc.FixedPoint,
    public readonly aMin: ccc.FixedPoint,
    public readonly bMinMatch: ccc.FixedPoint,
    public readonly bMaxMatch: ccc.FixedPoint,
    public readonly bMaxOut: ccc.FixedPoint,
    public readonly realRatio: number,
  ) {}

  /**
   * Factory method to create an OrderMatcher instance from an order.
   *
   * The method determines necessary matching parameters based on the matching direction
   * (CKB-to-UDT versus UDT-to-CKB) and calculates the maximum and minimum amounts
   * allowed for a valid match. It returns undefined if the parameters are invalid.
   *
   * @param order - The order cell to match.
   * @param isCkb2Udt - Indicates matching direction (true for CKB-to-UDT; false for UDT-to-CKB).
   * @param ckbMiningFee - The CKB mining fee as a fixed point, applied to the appropriate asset.
   *
   * @returns An instance of OrderMatcher if matching is possible; otherwise, undefined.
   */
  static from(
    order: OrderCell,
    isCkb2Udt: boolean,
    ckbMiningFee: ccc.FixedPoint,
  ): OrderMatcher | undefined {
    let aScale: ccc.Num;
    let bScale: ccc.Num;
    let aIn: ccc.FixedPoint;
    let bIn: ccc.FixedPoint;
    let aMin: ccc.FixedPoint;
    let bMinMatch: ccc.FixedPoint;
    let aMiningFee: ccc.FixedPoint;
    let bMiningFee: ccc.FixedPoint;

    if (isCkb2Udt) {
      // When converting CKB to UDT, extract scaling factors accordingly.
      ({ ckbScale: aScale, udtScale: bScale } = order.data.info.ckbToUdt);
      [aIn, bIn] = [order.ckbValue, order.udtValue];
      // Calculate the minimal match for UDT based on the order info.
      bMinMatch =
        (order.data.info.getCkbMinMatch() * bScale + aScale - 1n) / aScale;
      // aMin is determined by subtracting unoccupied capacity from the total capacity.
      aMin = order.cell.cellOutput.capacity - order.ckbUnoccupied;
      aMiningFee = ckbMiningFee;
      bMiningFee = 0n;
    } else {
      // When converting UDT to CKB, swap the scale factors.
      ({ ckbScale: bScale, udtScale: aScale } = order.data.info.ckbToUdt);
      [bIn, aIn] = [order.ckbValue, order.udtValue];
      bMinMatch = order.data.info.getCkbMinMatch();
      aMin = 0n;
      aMiningFee = 0n;
      bMiningFee = ckbMiningFee;
    }

    // Validate that there is sufficient input beyond the minimum required.
    if (aIn <= aMin + aMiningFee || aScale <= 0n || bScale <= 0n) {
      return;
    }

    // Calculate the maximum possible output for asset B, ensuring a non-decreasing property.
    const bMaxOut = OrderMatcher.nonDecreasing(aScale, bScale, aIn, bIn, aMin);
    const bMaxMatch = bMaxOut - bIn;
    if (bMinMatch > bMaxMatch) {
      bMinMatch = bMaxMatch;
    }

    const realRatio =
      Number(aIn - aMin - aMiningFee) / Number(bMaxMatch + bMiningFee);

    if (realRatio <= 0) {
      return;
    }

    return new OrderMatcher(
      order,
      isCkb2Udt,
      aScale,
      bScale,
      aIn,
      bIn,
      aMin,
      bMinMatch,
      bMaxMatch,
      bMaxOut,
      realRatio,
    );
  }

  /**
   * Computes a match result for the provided allowance on asset B.
   *
   * If the provided allowance is too low to fulfill even a partial match, an empty match is returned.
   * If the allowance meets or exceeds the maximum matchable amount, a complete match is returned.
   *
   * @param bAllowance - The allowance available for matching asset B.
   *
   * @returns A Match object containing delta values and the match details.
   */
  match(bAllowance: ccc.FixedPoint): Match {
    // Check if allowance is too low to even fulfill partially.
    if (bAllowance < this.bMinMatch) {
      return {
        ckbDelta: 0n,
        udtDelta: 0n,
        partials: [],
      };
    }

    // Check if allowance is sufficient for a complete match.
    if (bAllowance >= this.bMaxMatch) {
      return this.create(this.aMin, this.bMaxOut);
    }

    // For partial matches, calculate output values.
    const bOut = this.bIn + bAllowance;
    const aOut = OrderMatcher.nonDecreasing(
      this.bScale,
      this.aScale,
      this.bIn,
      this.aIn,
      bOut,
    );

    return this.create(aOut, bOut);
  }

  /**
   * Creates a Match result given the output amounts.
   *
   * Depending on the matching direction, it calculates the deltas:
   * - For CKB-to-UDT: the change in CKB is aIn - aOut and in UDT is bIn - bOut.
   * - For UDT-to-CKB: the change in CKB is bIn - bOut and in UDT is aIn - aOut.
   *
   * @param aOut - The computed output amount for asset A.
   * @param bOut - The computed output amount for asset B.
   *
   * @returns A Match object representing the result.
   */
  create(aOut: ccc.FixedPoint, bOut: ccc.FixedPoint): Match {
    return this.isCkb2Udt
      ? {
          ckbDelta: this.aIn - aOut,
          udtDelta: this.bIn - bOut,
          partials: [
            {
              order: this.order,
              ckbOut: aOut,
              udtOut: bOut,
            },
          ],
        }
      : {
          ckbDelta: this.bIn - bOut,
          udtDelta: this.aIn - aOut,
          partials: [
            {
              order: this.order,
              ckbOut: bOut,
              udtOut: aOut,
            },
          ],
        };
  }

  /**
   * Applies the limit order rule on non-decreasing value to calculate bOut.
   *
   * The formula finds the minimum bOut such that:
   *   aScale * aIn + bScale * bIn <= aScale * aOut + bScale * bOut
   *
   * Rearranging, we get:
   *   bOut = (aScale * (aIn - aOut) + bScale * bIn) / bScale
   *
   * Since integer division truncates, rounding is applied to guarantee an upper value:
   *
   *   bOut = (aScale * (aIn - aOut) + bScale * (bIn + 1) - 1) / bScale
   *
   * @param aScale - The scaling factor for asset A.
   * @param bScale - The scaling factor for asset B.
   * @param aIn - The input amount for asset A.
   * @param bIn - The input amount for asset B.
   * @param aOut - The output amount for asset A.
   *
   * @returns The computed output amount for asset B ensuring the non-decreasing property.
   */
  static nonDecreasing(
    aScale: ccc.Num,
    bScale: ccc.Num,
    aIn: ccc.FixedPoint,
    bIn: ccc.FixedPoint,
    aOut: ccc.FixedPoint,
  ): ccc.FixedPoint {
    return (aScale * (aIn - aOut) + bScale * (bIn + 1n) - 1n) / bScale;
  }
}
