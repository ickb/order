import { ccc } from "@ckb-ccc/core";
import type { UdtHandler } from "@ickb/dao";

export class Order {
  constructor(
    public script: ccc.Script,
    public cellDeps: ccc.CellDep[],
    public udtHandler: UdtHandler,
  ) {}
}
