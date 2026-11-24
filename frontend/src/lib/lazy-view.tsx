import { lazy, Suspense, type ComponentType } from "react";

/** Load large workspace tools only when they are rendered. */
export function lazyView<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
  Loading: ComponentType = () => null,
) {
  const View = lazy(async () => ({ default: await load() }));
  return function LazyView(props: Props) {
    return <Suspense fallback={<Loading />}><View {...props} /></Suspense>;
  };
}
