export class UsageImageCache {
  private readonly images = new Map<string, string>();

  isCurrent(actionId: string, image: string): boolean {
    return this.images.get(actionId) === image;
  }

  remember(actionId: string, image: string): void {
    this.images.set(actionId, image);
  }

  forget(actionId: string): void {
    this.images.delete(actionId);
  }
}
