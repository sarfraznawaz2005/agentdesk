import { cn } from "@/lib/utils"

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      aria-hidden="true"
    />
  )
}

function SkeletonCard() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
      <div className="flex items-center gap-2 pt-1">
        <Skeleton className="size-6 rounded-full" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  )
}

function SkeletonLine({ width }: { width?: string }) {
  return (
    <Skeleton
      className={cn("h-3 rounded", width ?? "w-full")}
    />
  )
}

export { Skeleton, SkeletonCard, SkeletonLine }
