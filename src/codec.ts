import { ccc, mol, OutPoint } from "@ckb-ccc/core";
import { Int32, union } from "@ickb/dao";

export interface RatioLike {
  ckbScale: ccc.NumLike;
  udtScale: ccc.NumLike;
}

@mol.codec(
  mol.struct({
    ckbScale: mol.Uint64,
    udtScale: mol.Uint64,
  }),
)
export class Ratio extends mol.Entity.Base<RatioLike, Ratio>() {
  constructor(
    public ckbScale: ccc.Num,
    public udtScale: ccc.Num,
  ) {
    super();
  }

  static override from(ratio: RatioLike): Ratio {
    if (ratio instanceof Ratio) {
      return ratio;
    }

    const { ckbScale, udtScale } = ratio;
    return new Ratio(ccc.numFrom(ckbScale), ccc.numFrom(udtScale));
  }

  isValid(): boolean {
    return this.isEmpty() || this.isPopulated();
  }

  isEmpty(): boolean {
    return this.ckbScale === 0n && this.udtScale === 0n;
  }

  isPopulated(): boolean {
    return this.ckbScale > 0n && this.udtScale > 0n;
  }
}

export interface InfoLike {
  ckbToUdt: RatioLike;
  udtToCkb: RatioLike;
  ckbMinMatchLog: ccc.NumLike;
}

@mol.codec(
  mol.struct({
    ckbToUdt: Ratio,
    udtToCkb: Ratio,
    ckbMinMatchLog: mol.Uint8,
  }),
)
export class Info extends mol.Entity.Base<InfoLike, Info>() {
  constructor(
    public ckbToUdt: Ratio,
    public udtToCkb: Ratio,
    public ckbMinMatchLog: number,
  ) {
    super();
  }

  static override from(info: InfoLike): Info {
    if (info instanceof Info) {
      return info;
    }

    const { ckbToUdt, udtToCkb, ckbMinMatchLog } = info;
    return new Info(
      Ratio.from(ckbToUdt),
      Ratio.from(udtToCkb),
      Number(ckbMinMatchLog),
    );
  }

  isValid(): boolean {
    if (this.ckbMinMatchLog < 0 || this.ckbMinMatchLog > 64) {
      return false;
    }

    if (this.ckbToUdt.isEmpty()) {
      return this.udtToCkb.isPopulated();
    }

    if (this.udtToCkb.isEmpty()) {
      return this.ckbToUdt.isPopulated();
    }

    return this.ckbToUdt.isPopulated() && this.udtToCkb.isPopulated();
  }
}

export interface RelativeLike {
  padding: ccc.BytesLike;
  distance: ccc.NumLike;
}

@mol.codec(
  mol.struct({
    padding: mol.Byte32,
    distance: Int32,
  }),
)
export class Relative extends mol.Entity.Base<RelativeLike, Relative>() {
  constructor(
    public padding: ccc.Bytes,
    public distance: ccc.Num,
  ) {
    super();
  }

  static override from(relative: RelativeLike): Relative {
    if (relative instanceof Relative) {
      return relative;
    }

    const { padding, distance } = relative;
    return new Relative(ccc.bytesFrom(padding), ccc.numFrom(distance));
  }

  static getPadding(): ccc.Bytes {
    return new Uint8Array(32);
  }

  isValid(): boolean {
    return !this.padding.some((x) => x !== 0);
  }
}

export const MasterCodec = union({
  relative: Relative,
  absolute: OutPoint,
});

export type MasterLike = mol.EncodableType<typeof MasterCodec>;
export type Master = mol.DecodedType<typeof MasterCodec>;

function masterFrom(master: MasterLike): Master {
  const { type, value } = master;
  if (type === "relative") {
    return { type, value: Relative.from(value) };
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  } else if (type === "absolute") {
    return { type, value: ccc.OutPoint.from(value) };
  } else {
    throw Error(`Invalid type ${String(type)}, not relative, not absolute`);
  }
}

function masterIsValid(master: Master): boolean {
  const { type, value } = master;
  if (type === "relative") {
    return value.isValid();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  } else if (type === "absolute") {
    return /^0x[0-9a-f]{64}$/i.test(value.txHash) && value.index >= 0;
  } else {
    throw Error(`Invalid type ${String(type)}, not relative, not absolute`);
  }
}

export interface DataLike {
  udtAmount: ccc.NumLike;
  master: MasterLike;
  info: InfoLike;
}

@mol.codec(
  mol.struct({
    udtAmount: mol.Uint128,
    master: MasterCodec,
    info: Info,
  }),
)
export class Data extends mol.Entity.Base<DataLike, Data>() {
  constructor(
    public udtAmount: ccc.Num,
    public master: Master,
    public info: Info,
  ) {
    super();
  }

  static override from(data: DataLike): Data {
    if (data instanceof Data) {
      return data;
    }

    const { udtAmount, master, info } = data;
    return new Data(
      ccc.numFrom(udtAmount),
      masterFrom(master),
      Info.from(info),
    );
  }

  isValid(): boolean {
    return (
      this.udtAmount >= 0n && masterIsValid(this.master) && this.info.isValid()
    );
  }
}
