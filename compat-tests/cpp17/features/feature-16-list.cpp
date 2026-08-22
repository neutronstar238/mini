#include <iostream>
#include <list>
int main(){ std::list<int> x{1,3}; x.insert(std::next(x.begin()),2); int s=0; for(int v:x)s+=v; std::cout<<s<<"\n"; }
