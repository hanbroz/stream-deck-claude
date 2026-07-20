export class CodeStartLaunchGuard {
  private readonly bindingIds = new Set<string>();

  begin(bindingId: string): boolean {
    if (this.bindingIds.has(bindingId)) {
      return false;
    }
    this.bindingIds.add(bindingId);
    return true;
  }

  end(bindingId: string): void {
    this.bindingIds.delete(bindingId);
  }

  isLaunching(bindingId: string): boolean {
    return this.bindingIds.has(bindingId);
  }
}
