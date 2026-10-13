/** Gives supporting routes a compact heading that reserves less height on landscape phones. */
export function PageHeading({ code, title, description }: { code: string; title: string; description: string }) {
  return (
    <div className="mb-7 flex flex-col gap-3 border-b border-[#165b80] pb-6 sm:mb-9 sm:flex-row sm:items-end sm:justify-between phoneLandscape:mb-4 phoneLandscape:flex-row phoneLandscape:items-end phoneLandscape:justify-between phoneLandscape:pb-3">
      <div className="min-w-0 shrink-0">
        <p className="mb-2 text-xs tracking-[.2em] text-[#1c7ba6] phoneLandscape:mb-1">{code}</p>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl phoneLandscape:text-2xl">{title}</h1>
      </div>
      <p className="min-w-0 max-w-md text-sm leading-6 text-[#567287] phoneLandscape:max-w-xs phoneLandscape:text-xs phoneLandscape:leading-5">{description}</p>
    </div>
  );
}
