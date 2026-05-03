export declare function StringEnum<T extends string>(values: readonly T[], options?: {
    description?: string;
}): import("@sinclair/typebox").TUnsafe<T>;
export declare function NumberEnum<T extends number>(values: readonly T[], options?: {
    description?: string;
}): import("@sinclair/typebox").TUnsafe<T>;
