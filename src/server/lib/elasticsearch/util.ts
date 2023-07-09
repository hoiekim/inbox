export class Pagination {
  from = 0;
  size = 10000;

  constructor(page?: number, size?: number) {
    if (size) this.size = size;
    if (page) this.from = Math.ceil((Math.max(page, 1) - 1) * this.size);
  }
}
