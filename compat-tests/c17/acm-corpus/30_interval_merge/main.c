#include <stdio.h>
typedef struct{int l,r;} Interval;
int main(void){Interval a[]={{1,3},{2,6},{8,10},{9,12}};int out=0;for(int i=0;i<4;++i){if(out&&a[i].l<=a[out-1].r){if(a[i].r>a[out-1].r)a[out-1].r=a[i].r;}else a[out++]=a[i];}printf("%d:%d-%d %d-%d\n",out,a[0].l,a[0].r,a[1].l,a[1].r);return 0;}
